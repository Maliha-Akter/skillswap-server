const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
// ✅ FIX: Combined both imports into a single clean line to prevent Syntax/Redeclaration crashes
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
const RATING_VALUES = {
    'Excellent': 5,
    'Good': 4,
    'Average': 3,
    'Poor': 2,
    'Very Poor': 1
};

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // 1. Establishing database connection safely
        await client.connect();

        // 2. Selecting database and establish collection references
        const db = client.db('skillswap');
        const tasksCollection = db.collection('tasks');
        const proposalsCollection = db.collection('proposals');
        const paymentsCollection = db.collection('payments');
        const reviewsCollection = db.collection('reviews');
        const usersCollection = db.collection('user');

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");


        // -------------------------------------------------------------------------
        // 🛡️ ADMIN ACCESS CONTROL MIDDLEWARE
        // -------------------------------------------------------------------------
        const authAdmin = async (req, res, next) => {
            try {
                const userEmail = req.headers['user-email'];
                console.log("==> [BACKEND AUTH] Checking verification header for email:", userEmail);

                if (!userEmail) {
                    return res.status(401).json({ message: "Unauthorized: Missing identity header." });
                }

                // 1. Parse admin emails array from your environment variables configuration
                const envAdminEmails = process.env.ADMIN_EMAILS
                    ? process.env.ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase())
                    : [];

                const incomingEmailLower = userEmail.toLowerCase();

                // 2. STAGE A Validation: Instant match if found in our safe env list
                if (envAdminEmails.includes(incomingEmailLower)) {
                    console.log(`==> [BACKEND AUTH] Authorized master access via environment mapping rule for: ${userEmail}`);
                    return next();
                }

                // 3. STAGE B Validation: Standard fallback collection lookup matching your "user" table
                const user = await usersCollection.findOne({ email: userEmail });
                console.log("==> [BACKEND AUTH] Database user lookup record resolved:", user);

                if (!user || user.role !== 'admin') {
                    console.log(`==> [BACKEND AUTH] Denied. Found Role: ${user ? user.role : 'None'}`);
                    return res.status(403).json({ message: "Forbidden: Administrative clearance required." });
                }

                console.log(`==> [BACKEND AUTH] Authorized database role check matching administration context.`);
                next();
            } catch (error) {
                console.error("==> [BACKEND AUTH CRITICAL ERROR]:", error);
                return res.status(500).json({ message: "Internal authentication error." });
            }
        };

        // -------------------------------------------------------------------------
        // 👥 ADMIN: FETCH & FILTER USERS ENDPOINT
        // -------------------------------------------------------------------------
        app.get('/api/admin/users', authAdmin, async (req, res) => {
            try {
                const { search, role } = req.query;
                console.log(`==> [BACKEND GET /api/admin/users] Query params received - Search: "${search || ''}", Role: "${role || ''}"`);

                let query = {};

                if (search) {
                    query.$or = [
                        { name: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } }
                    ];
                }

                if (role && role !== 'all') {
                    query.role = role.toLowerCase();
                }

                console.log("==> [BACKEND] Executing MongoDB user query:", JSON.stringify(query));

                const users = await usersCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                console.log(`==> [BACKEND] Query completed successfully. Returning ${users.length} user documents.`);

                return res.status(200).json({
                    success: true,
                    data: users
                });
            } catch (error) {
                console.error("==> [BACKEND CRITICAL ROUTE ERROR] GET /api/admin/users:", error);
                return res.status(500).json({
                    success: false,
                    message: "Failed to load platform accounts collection.",
                    error: error.message
                });
            }
        });

        // -------------------------------------------------------------------------
        // 🚫 ADMIN: TOGGLE USER BLOCK/UNBLOCK PERMISSIONS STATUS
        // -------------------------------------------------------------------------
        app.patch('/api/admin/users/:id/block', authAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const { isBlocked } = req.body;

                if (typeof isBlocked !== 'boolean') {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid status parameters payload format. Property must be boolean value."
                    });
                }

                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isBlocked } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({
                        success: false,
                        message: "Target user account not found."
                    });
                }

                return res.status(200).json({
                    success: true,
                    message: `User ${isBlocked ? "Blocked" : "Active"} successfully.`
                });

            } catch (error) {
                console.error(error);
                return res.status(500).json({
                    success: false,
                    message: error.message
                });
            }
        });

        // 🟢 GET ALL TASKS PIPELINE (WITH FILTERING & ADMINISTRATIVE AUDITING)
        app.get("/api/admin/tasks", authAdmin, async (req, res) => {
            try {
                const { search, categories, status, minBudget, maxBudget } = req.query;

                console.log("==================================================");
                console.log("==> [INCOMING REQ] GET /api/admin/tasks");
                console.log("    Raw Query Params:", { search, categories, status, minBudget, maxBudget });

                let query = {};

                // 1. Debounced Text Title Search
                if (search) {
                    query.title = { $regex: search, $options: "i" };
                }

                // 2. Categories Multi-Select Checkboxes
                if (categories) {
                    const categoryList = categories.split(",");
                    if (categoryList.length > 0 && categoryList[0] !== "") {
                        query.category = { $in: categoryList };
                    }
                }

                // 3. Live Status Tracks (Open, in_progress, Completed)
                if (status && status.toLowerCase() !== "all") {
                    query.status = { $regex: new RegExp(`^${status}$`, "i") };
                }

                // 4. Budget Range Tiers & Custom Bounds
                if (minBudget || maxBudget) {
                    query.budget = {};
                    if (minBudget) query.budget.$gte = parseFloat(minBudget);
                    if (maxBudget) query.budget.$lte = parseFloat(maxBudget);
                }

                console.log("==> [MONGO QUERY] Generated Filter Object:");
                console.dir(query, { depth: null });

                const tasks = await tasksCollection.find(query).sort({ createdAt: -1 }).toArray();

                console.log(`==> [MONGO RESULT] Successfully fetched ${tasks.length} task row documents.`);
                console.log("==================================================");

                res.status(200).json({
                    success: true,
                    data: tasks
                });
            } catch (error) {
                console.error("❌ ==> [CRITICAL ROUTE ERROR] GET /api/admin/tasks:", error);
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // 🔴 DELETE TASK ITEM ROW (SAFETY GUIDELINES / VIOLATIONS TERMINATION)
        // ✅ Added authAdmin protection here too so standard users can't delete items using tools like Postman!
        app.delete("/api/admin/tasks/:id", authAdmin, async (req, res) => {
            try {
                const { id } = req.params;

                // Uses the top-level inherited or safely imported ObjectId reference
                const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 1) {
                    res.status(200).json({
                        success: true,
                        message: "Task item removed permanently due to platform safety violations."
                    });
                } else {
                    res.status(404).json({ success: false, message: "Requested task document profile not found." });
                }
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // -------------------------------------------------------------------------
        // 📊 ADMINISTRATIVE AGGREGATED METRICS & OVERVIEW ENDPOINT
        // -------------------------------------------------------------------------
        app.get('/api/admin/overview-stats', authAdmin, async (req, res) => {
            try {
                console.log("==> [BACKEND OVERVIEW] Aggregating multi-collection dataset streams...");

                // 1. Fetch Fundamental Counts and Totals
                const totalUsers = await usersCollection.countDocuments({});
                const totalTasks = await tasksCollection.countDocuments({});
                const activeTasks = await tasksCollection.countDocuments({ status: "in_progress" });
                const completedTasks = await tasksCollection.countDocuments({ status: "Completed" });
                const pendingProposals = await proposalsCollection.countDocuments({ status: "pending" });
                const blockedUsers = await usersCollection.countDocuments({ isBlocked: true });
                const successfulPayments = await paymentsCollection.countDocuments({ payment_status: "paid" });

                // 2. Compute Total Financial Revenue
                const revenueAggregation = await paymentsCollection.aggregate([
                    { $match: { payment_status: "paid" } },
                    { $group: { _id: null, total: { $sum: "$amount" } } }
                ]).toArray();
                const totalRevenue = revenueAggregation[0]?.total || 0;

                // 3. Build Task Distribution Status Chart
                const todoCount = await tasksCollection.countDocuments({ status: "todo" });
                const inProgressCount = await tasksCollection.countDocuments({ status: "in_progress" });
                const doneCount = await tasksCollection.countDocuments({ status: "completed" });

                // 4. Generate Last 6 Months/Days Revenue Points Timeline
                // If data is scarce, it falls back gracefully to standard increments mapped over your layout
                const recentPaymentsList = await paymentsCollection.find({ payment_status: "paid" })
                    .sort({ paid_at: -1 })
                    .limit(6)
                    .toArray();

                // Map live transaction nodes into simplified date values for the UI chart bars
                const revenueChart = recentPaymentsList.map(pay => ({
                    date: pay.paid_at ? new Date(pay.paid_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recent',
                    amount: pay.amount || 0
                })).reverse();

                // If revenue streams are empty, inject baseline historical milestones automatically
                if (revenueChart.length === 0) {
                    revenueChart.push({ date: 'Base', amount: 0 });
                }

                // 5. Fetch Recent Activity Feed Document Lists
                const recentTasks = await tasksCollection.find({}).sort({ _id: -1 }).limit(5).toArray();
                const recentUsers = await usersCollection.find({}).sort({ _id: -1 }).limit(5).toArray();
                const recentPayments = await paymentsCollection.find({}).sort({ paid_at: -1 }).limit(5).toArray();

                // 6. Return standard structured response object wrapper
                return res.status(200).json({
                    success: true,
                    data: {
                        stats: {
                            totalUsers,
                            totalTasks,
                            totalRevenue,
                            activeTasks,
                            completedTasks,
                            pendingProposals,
                            blockedUsers,
                            successfulPayments
                        },
                        revenueChart,
                        taskStatusChart: {
                            todo: todoCount,
                            in_progress: inProgressCount,
                            completed: doneCount
                        },
                        recentTasks,
                        recentUsers,
                        recentPayments
                    }
                });

            } catch (error) {
                console.error("❌ ==> [BACKEND AGGREGATION CRITICAL CRASH]:", error);
                return res.status(500).json({
                    success: false,
                    message: "Internal server fault executing multi-collection database aggregation pipeline."
                });
            }
        });

        // -------------------------------------------------------------------------
        // 🛠️ FREELANCER AGGREGATED WORKSPACE STATISTICS & OVERVIEW PIPELINE
        // -------------------------------------------------------------------------
        // -------------------------------------------------------------------------
        // 🛠️ CORRECTED FREELANCER AGGREGATED WORKSPACE STATISTICS PIPELINE
        // -------------------------------------------------------------------------
        app.get('/api/freelancer/overview-stats', async (req, res) => {
            try {
                const freelancerEmail = req.headers['user-email'];
                if (!freelancerEmail) {
                    return res.status(400).json({ success: false, message: "Identification header missing." });
                }

                console.log(`==> [FREELANCER OVERVIEW] Syncing dataset for: ${freelancerEmail}`);

                // 1. Get proposal statuses directly from the proposals collection (using your exact schema variables)
                // Note: Your schema snippet shows status "rejected" (lowercase). We will support both exact match and lowercase.
                const totalProposals = await proposalsCollection.countDocuments({ freelancer_email: freelancerEmail });

                const pendingProposals = await proposalsCollection.countDocuments({
                    freelancer_email: freelancerEmail,
                    status: { $regex: /^pending$/i } // Case-insensitive match for safety
                });

                const acceptedProposals = await proposalsCollection.countDocuments({
                    freelancer_email: freelancerEmail,
                    status: { $regex: /^accepted$/i }
                });

                const rejectedProposals = await proposalsCollection.countDocuments({
                    freelancer_email: freelancerEmail,
                    status: { $regex: /^rejected$/i }
                });

                // 2. Find all tasks that this freelancer had an accepted proposal for
                const acceptedBids = await proposalsCollection.find({
                    freelancer_email: freelancerEmail,
                    status: { $regex: /^accepted$/i }
                }).toArray();

                // Extract the task IDs that belong to this freelancer
                const freelancerTaskIds = acceptedBids.map(bid => bid.task_id);

                // 3. Calculate Total Earnings from the tasks table where the task is Completed
                // FIXED: Using your exact capitalized status: "Completed"
                const completedTasksAggregation = await tasksCollection.aggregate([
                    {
                        $match: {
                            _id: { $in: freelancerTaskIds },
                            status: "Completed" // 💎 EXACT CAPITALIZATION MATCH FROM YOUR DB
                        }
                    },
                    { $group: { _id: null, total: { $sum: "$budget" } } }
                ]).toArray();

                const totalEarnings = completedTasksAggregation[0]?.total || 0;

                // 4. Build Earnings History Stream using completed tasks
                const completedTasksList = await tasksCollection.find({
                    _id: { $in: freelancerTaskIds },
                    status: "Completed"
                })
                    .sort({ completedAt: -1 }) // Sorting by your schema's completedAt timestamp
                    .limit(6)
                    .toArray();

                const earningsChart = completedTasksList.map(task => ({
                    date: task.completedAt ? new Date(task.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recent',
                    amount: task.budget || 0
                })).reverse();

                if (earningsChart.length === 0) {
                    earningsChart.push({ date: 'Initiated', amount: 0 });
                }

                // 5. Fetch Horizontal Row Feeds for the UI
                // Row Feed A: Recent Proposals submitted by this freelancer
                const recentProposalsRaw = await proposalsCollection.find({ freelancer_email: freelancerEmail })
                    .sort({ submitted_at: -1 }) // Uses your schema's submitted_at property
                    .limit(5)
                    .toArray();

                // Map proposals and join task titles so your frontend has a project title to show
                const recentProposals = await Promise.all(recentProposalsRaw.map(async (prop) => {
                    const taskInfo = await tasksCollection.findOne({ _id: prop.task_id });
                    return {
                        _id: prop._id,
                        taskTitle: taskInfo ? taskInfo.title : "Unknown Assignment Brief",
                        bidAmount: prop.proposed_budget, // Uses your schema's proposed_budget variable
                        coverLetter: prop.cover_note,     // Uses your schema's cover_note variable
                        status: prop.status
                    };
                }));

                // Row Feed B: Active Ongoing Contracts (Tasks that are accepted but not completed yet)
                const activeContracts = await tasksCollection.find({
                    _id: { $in: freelancerTaskIds },
                    status: { $ne: "Completed" } // Anything not completed yet is considered processing
                })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray();

                // 6. Return the safe response package payload
                return res.status(200).json({
                    success: true,
                    data: {
                        stats: {
                            totalProposals,
                            pendingProposals,
                            acceptedProposals,
                            totalEarnings
                        },
                        earningsChart,
                        proposalStatusChart: {
                            pending: pendingProposals,
                            accepted: acceptedProposals,
                            rejected: rejectedProposals
                        },
                        recentProposals,
                        activeContracts
                    }
                });

            } catch (error) {
                console.error("❌ ==> [BACKEND FREELANCER AGGREGATION FAILURE]:", error);
                return res.status(500).json({
                    success: false,
                    message: "Internal server error gathering aggregate data pipeline workflows."
                });
            }
        });
        // -------------------------------------------------------------------------
        // 🛠️ CLIENT AGGREGATED WORKSPACE STATISTICS PIPELINE
        // -------------------------------------------------------------------------
        app.get('/api/client/overview-stats', async (req, res) => {
            try {
                const clientEmail = req.headers['user-email'];
                if (!clientEmail) {
                    return res.status(400).json({ success: false, message: "Identification header missing." });
                }

                console.log(`==> [CLIENT OVERVIEW] Syncing dataset for: ${clientEmail}`);

                // 1. Core Task Counts matching your specific layout requirements
                const totalTasks = await tasksCollection.countDocuments({ client_email: clientEmail });

                // Open Tasks = Tasks that are still in "todo" or looking for bids
                const openTasks = await tasksCollection.countDocuments({
                    client_email: clientEmail,
                    status: { $regex: /^open$/i }
                });

                // Tasks In Progress = Active contracts currently being built
                const tasksInProgress = await tasksCollection.countDocuments({
                    client_email: clientEmail,
                    status: { $regex: /^in_progress$/i }
                });

                // 2. Total Spent = Sum of budgets from tasks that are officially finished
                const completedExpenditure = await tasksCollection.aggregate([
                    {
                        $match: {
                            client_email: clientEmail,
                            status: "Completed" // Exact capitalization match from your database schema
                        }
                    },
                    { $group: { _id: null, total: { $sum: "$budget" } } }
                ]).toArray();

                const totalSpent = completedExpenditure[0]?.total || 0;

                // 3. Optional: Extra telemetry structures to keep layout uniform with your feeds
                const recentTasks = await tasksCollection.find({ client_email: clientEmail })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray();

                // 4. Safely package and dispatch the data matrix response
                return res.status(200).json({
                    success: true,
                    data: {
                        stats: {
                            totalTasks,
                            openTasks,
                            tasksInProgress,
                            totalSpent
                        },
                        recentTasks
                    }
                });

            } catch (error) {
                console.error("❌ ==> [BACKEND CLIENT AGGREGATION FAILURE]:", error);
                return res.status(500).json({
                    success: false,
                    message: "Internal server error gathering aggregate client workflow metrics."
                });
            }
        });
        // -------------------------------------------------------------------------
        // 🚀 FETCH LATEST FEATURED OPEN TASKS FOR USER FEEDS
        // -------------------------------------------------------------------------
        app.get('/api/tasks/featured-open', async (req, res) => {
            try {
                // Query tasks that are open ("todo") sorted by newest creation date
                const featuredTasks = await tasksCollection.find({
                    status: { $regex: /^open$/i }
                })
                    .sort({ createdAt: -1 })
                    .limit(6) // Limit to the top 6 most recent open postings
                    .toArray();

                return res.status(200).json({
                    success: true,
                    data: featuredTasks
                });
            } catch (error) {
                console.error("❌ ==> [FETCH FEATURED TASKS EXCEPTION]:", error);
                return res.status(500).json({ success: false, message: "Internal server error fetching featured listings." });
            }
        });
        app.post('/api/reviews', async (req, res) => {
            try {
                const { taskId, reviewerEmail, revieweeEmail, rating, comment } = req.body;

                // Validate payload fields
                if (!taskId || !reviewerEmail || !revieweeEmail || !rating || !comment) {
                    return res.status(400).json({ message: "All fields are required." });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const taskOId = new ObjectId(taskId);

                // Prevent duplicate reviews for the same task
                const existingReview = await reviewsCollection.findOne({ taskId: taskOId });
                if (existingReview) {
                    return res.status(400).json({ message: "This task has already been reviewed." });
                }

                // Construct clean data document
                const reviewRecord = {
                    taskId: taskOId,
                    reviewerEmail,
                    revieweeEmail,
                    rating, // Expecting: 'Very Poor', 'Poor', 'Average', 'Good', or 'Excellent'
                    comment,
                    createdAt: new Date()
                };

                const result = await reviewsCollection.insertOne(reviewRecord);

                return res.status(201).json({
                    message: "Review submitted successfully!",
                    reviewId: result.insertedId
                });

            } catch (error) {
                console.error("POST /api/reviews Error:", error);
                return res.status(500).json({ message: "Internal server error saving feedback entry." });
            }
        });
        app.get('/api/reviews', async (req, res) => {
            try {
                const { taskId } = req.query;

                if (!taskId) {
                    return res.status(400).json({ message: "taskId query parameter is required." });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const taskOId = new ObjectId(taskId);

                // 1. Find the existing review if it exists
                const review = await reviewsCollection.findOne({ taskId: taskOId });

                // 2. Query proposal checking BOTH ObjectId and String formats to prevent silent mismatches
                const acceptedProposal = await proposalsCollection.findOne({
                    $or: [
                        { task_id: taskOId },
                        { task_id: taskId }
                    ],
                    status: { $in: ['accepted', 'approved', 'Accepted', 'Approved'] }
                });

                // Debugging logs — check your terminal/console when this endpoint runs!
                console.log("=== Debugging Review Pipeline ===");
                console.log("Target Task ID:", taskId);
                console.log("Found Proposal Document:", acceptedProposal);

                // Fallback checks just in case field names are snake_case vs camelCase
                const freelancerEmail = acceptedProposal
                    ? (acceptedProposal.freelancer_email || acceptedProposal.freelancerEmail)
                    : null;

                return res.status(200).json({
                    review: review || null,
                    revieweeEmail: freelancerEmail
                });

            } catch (error) {
                console.error("GET /api/reviews Error:", error);
                return res.status(500).json({ message: "Internal server error retrieving review data." });
            }
        });
        // New endpoint: Get all reviews for a specific freelancer by email
        app.get('/api/freelancer-reviews', async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Email query parameter is required." });
                }

                // Find all reviews where this freelancer was reviewed
                const reviews = await reviewsCollection.find({ revieweeEmail: email }).toArray();

                return res.status(200).json(reviews);
            } catch (error) {
                console.error("GET /api/freelancer-reviews Error:", error);
                return res.status(500).json({ message: "Internal server error retrieving profile reviews." });
            }
        });
        /**
         * NEW ENDPOINT: GET /tasks/:id/proposals
         * Purpose: Fetch all active proposals linked to a target task.
         */
        app.get('/tasks/:id/proposals', async (req, res) => {
            try {
                const taskId = req.params.id;

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format parameters." });
                }

                const taskOId = new ObjectId(taskId);

                // Based on your post route, your field name is explicitly 'task_id' as an ObjectId
                const query = { task_id: taskOId };

                const proposals = await proposalsCollection
                    .find(query)
                    .sort({ submitted_at: -1 }) // ✨ FIXED: Changed from createdAt to submitted_at
                    .toArray();

                return res.status(200).json({
                    total: proposals.length,
                    proposals: proposals
                });

            } catch (error) {
                console.error("GET /tasks/:id/proposals Error:", error);
                return res.status(500).json({ message: "Internal server error fetching pipeline proposals." });
            }
        });
        // -------------------------------------------------------------------------
        // 💳 ADMIN TRANSACTIONS HISTORY API ENDPOINT
        // -------------------------------------------------------------------------
        app.get('/payments', authAdmin, async (req, res) => {
            try {
                console.log("==> [BACKEND] Fetching absolute Stripe payment ledger items...");

                // Querying payments collection and sort by most recent transaction
                const payments = await paymentsCollection
                    .find({})
                    .sort({ paid_at: -1 }) // Sort from newest to oldest
                    .toArray();

                console.log(`==> [BACKEND SUCCESS] Transmitted ${payments.length} transaction records.`);

                // Return matching data layout structured for array validation check on frontend
                return res.status(200).json(payments);
            } catch (error) {
                console.error("❌ ==> [BACKEND TRANSACTIONS ERROR]:", error);
                return res.status(500).json({
                    success: false,
                    message: "Internal cluster exception reading database transactions matrix."
                });
            }
        });
        /**
         * NEW ENDPOINT: POST /payments
         * Purpose: Process successful payments and cascade status changes.
         * 1. Inserts payment row into 'payments' collection
         * 2. Updates the chosen freelancer's proposal status to 'accepted'
         * 3. Rejects all other proposals for this specific task
         * 4. Updates the task status to 'in_progress'
         */
        app.post('/payments', async (req, res) => {
            try {
                const {
                    clientEmail,
                    freelancerEmail,
                    taskId,
                    proposalId,
                    amount,
                    transactionId
                } = req.body;

                // Validate request data
                if (!clientEmail || !freelancerEmail || !taskId || !proposalId || !amount || !transactionId) {
                    return res.status(400).json({ message: "Missing required transactional payload fields." });
                }

                if (!ObjectId.isValid(taskId) || !ObjectId.isValid(proposalId)) {
                    return res.status(400).json({ message: "Invalid Task ID or Proposal ID format." });
                }

                const taskOId = new ObjectId(taskId);
                const proposalOId = new ObjectId(proposalId);

                // 🛡️ NEW STEP: Check if this client has already paid this freelancer for this specific task
                const existingPayment = await paymentsCollection.findOne({
                    task_id: taskOId,
                    freelancer_email: freelancerEmail,
                    payment_status: "paid" // Optional: ensures you only block if the past attempt actually succeeded
                });

                if (existingPayment) {
                    return res.status(409).json({
                        message: "Payment already processed. You have already funded this task for this freelancer."
                    });
                }

                // 1. Insert transaction history record into the payments collection
                const paymentRecord = {
                    client_email: clientEmail,
                    freelancer_email: freelancerEmail,
                    task_id: taskOId,
                    amount: Number(amount),
                    transaction_id: transactionId,
                    payment_status: "paid",
                    paid_at: new Date()
                };
                const paymentResult = await paymentsCollection.insertOne(paymentRecord);

                // 2. Update the winning proposal status to "accepted"
                await proposalsCollection.updateOne(
                    { _id: proposalOId },
                    { $set: { status: "accepted" } }
                );

                // 3. Reject all other proposals for this specific task row
                await proposalsCollection.updateMany(
                    {
                        task_id: taskOId,
                        _id: { $ne: proposalOId }
                    },
                    { $set: { status: "rejected" } }
                );

                // 4. Update the task status to "in_progress"
                await tasksCollection.updateOne(
                    { _id: taskOId },
                    { $set: { status: "in_progress" } }
                );

                return res.status(201).json({
                    message: "Payment tracked and task workflow updated to In Progress!",
                    paymentId: paymentResult.insertedId
                });

            } catch (error) {
                console.error("POST /payments Error:", error);
                return res.status(500).json({ message: "Internal server error processing payment transaction." });
            }
        });
        app.get('/freelancer-active-projects', async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Missing 'email' query parameter." });
                }

                // 3. Define pipeline execution
                const pipeline = [
                    {
                        $match: {
                            freelancer_email: email,
                            payment_status: "paid"
                        }
                    },
                    {
                        $addFields: {
                            converted_task_id: {
                                $toObjectId: {
                                    $trim: {
                                        input: { $toString: "$task_id" }
                                    }
                                }
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "tasks",
                            localField: "converted_task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                ];

                const testAggregation = await paymentsCollection.aggregate(pipeline).toArray();

                // Final safe aggregation pipeline for output production
                const finalPipeline = [
                    { $match: { freelancer_email: email, payment_status: "paid" } },
                    {
                        $addFields: {
                            converted_task_id: {
                                $toObjectId: {
                                    $trim: {
                                        input: { $toString: "$task_id" }
                                    }
                                }
                            }
                        }
                    },
                    { $lookup: { from: "tasks", localField: "converted_task_id", foreignField: "_id", as: "taskDetails" } },
                    { $match: { "taskDetails.0": { $exists: true } } },
                    { $unwind: "$taskDetails" },

                    // 🛠️ FIX: Combine rows sharing the exact same task ID to completely prevent duplicates
                    {
                        $group: {
                            _id: "$taskDetails._id",
                            paymentId: { $first: "$_id" },
                            transactionId: { $first: "$transaction_id" },
                            amountPaid: { $first: "$amount" },
                            title: { $first: "$taskDetails.title" },
                            category: { $first: "$taskDetails.category" },
                            description: { $first: "$taskDetails.description" },
                            deadline: { $first: "$taskDetails.deadline" },
                            clientEmail: { $first: "$client_email" },
                            status: { $first: { $toLower: "$taskDetails.status" } },
                            deliverableUrl: { $first: "$taskDetails.deliverable_url" },
                            createdAt: { $first: "$taskDetails.createdAt" }
                        }
                    },

                    { $sort: { "createdAt": -1 } },
                    {
                        $project: {
                            _id: 0,
                            taskId: "$_id",
                            paymentId: 1,
                            transactionId: 1,
                            amountPaid: 1,
                            title: 1,
                            category: 1,
                            description: 1,
                            deadline: 1,
                            clientEmail: 1,
                            status: 1,
                            deliverableUrl: 1
                        }
                    }
                ];

                const activeProjects = await paymentsCollection.aggregate(finalPipeline).toArray();

                return res.status(200).json(activeProjects);
            } catch (error) {
                return res.status(500).json({ message: "Failed to compile active project streams." });
            }
        });
        app.get('/freelancer-earnings', async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Missing 'email' query parameter." });
                }

                // 1. Fetch all successful payments for this freelancer
                const payments = await paymentsCollection.find({
                    freelancer_email: email,
                    payment_status: "paid"
                }).toArray();

                // 2. Calculate operational metrics manually (super safe, no aggregation errors)
                let totalEarned = 0;
                const paymentCount = payments.length;

                // Initialize empty monthly bins
                const monthlyTotals = {
                    Jan: 0, Feb: 0, Mar: 0, Apr: 0, May: 0, Jun: 0,
                    Jul: 0, Aug: 0, Sep: 0, Oct: 0, Nov: 0, Dec: 0
                };

                // Create an array to hold history items with task details
                const history = [];

                for (const payment of payments) {
                    const amount = payment.amount || 0;
                    totalEarned += amount;

                    // Track monthly distribution based on paid_at date string or object
                    if (payment.paid_at) {
                        const dateObj = new Date(payment.paid_at);
                        const monthName = dateObj.toLocaleString('en-US', { month: 'short' }); // e.g., "Jun"
                        if (monthlyTotals[monthName] !== undefined) {
                            monthlyTotals[monthName] += amount;
                        }
                    }

                    // Look up the matching task simply
                    let taskTitle = "Assignment Project";
                    try {
                        if (payment.task_id) {
                            const task = await tasksCollection.findOne({ _id: new ObjectId(payment.task_id.toString().trim()) });
                            if (task) {
                                taskTitle = task.title;
                            }
                        }
                    } catch (err) {
                        // If ObjectId conversion fails, keep default title and don't crash
                        console.error("Task look up skipped or failed for ID:", payment.task_id);
                    }

                    // Format history item
                    history.push({
                        id: payment._id,
                        taskTitle: taskTitle,
                        clientEmail: payment.client_email || "client@gmail.com",
                        amount: amount,
                        date: payment.paid_at || new Date(),
                        transactionId: payment.transaction_id || "N/A"
                    });
                }

                const averagePerTask = paymentCount > 0 ? parseFloat((totalEarned / paymentCount).toFixed(2)) : 0;

                // 3. Format monthly chart data array for frontend
                const baseMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const chartData = baseMonths.map(month => ({
                    name: month,
                    earnings: monthlyTotals[month]
                }));

                // Sort history by date descending (newest first)
                history.sort((a, b) => new Date(b.date) - new Date(a.date));

                // Return final clean response object
                return res.status(200).json({
                    summary: {
                        totalEarned,
                        paymentCount,
                        averagePerTask
                    },
                    chartData,
                    history
                });

            } catch (error) {
                console.error("Backend Error:", error);
                return res.status(500).json({ message: "Failed to compile financial metrics." });
            }
        });

        /**
         * PATCH /tasks/:id/submit-deliverable
         * Submits assignment assets and changes job workflow state to completed
         */
        app.patch('/tasks/:id/submit-deliverable', async (req, res) => {
            try {
                const { id } = req.params;
                const { deliverableUrl } = req.body;

                if (!deliverableUrl) {
                    return res.status(400).json({ message: "A valid submission reference link is required." });
                }
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid project identifier provided." });
                }

                // FIX 3: Replaced 'db.collection('tasks')' with your global tasksCollection variable if 'db' isn't defined
                const result = await tasksCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status: "Completed", // Match assignment capitalization schema rules
                            deliverable_url: deliverableUrl,
                            completedAt: new Date()
                        }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Target project task item not found." });
                }

                return res.status(200).json({ message: "Deliverable uploaded successfully and workflow closed!" });
            } catch (error) {
                console.error("PATCH /submit-deliverable error:", error);
                return res.status(500).json({ message: "Internal server error updating task status." });
            }
        });
        // GET /task-details/:id
        // app.get('/task-details/:id', async (req, res) => {
        //     try {
        //         const { id } = req.params;

        //         if (!id || id === 'undefined') {
        //             return res.status(400).json({ message: "Invalid or missing Task Identifier parameter." });
        //         }

        //         // Search using the database entry string conversion safely
        //         const task = await tasksCollection.findOne({ _id: new ObjectId(id.toString().trim()) });

        //         if (!task) {
        //             return res.status(404).json({ message: "The specified task profile could not be found." });
        //         }

        //         // Return all fields requested with fallback data types
        //         return res.status(200).json({
        //             _id: task._id,
        //             title: task.title || "Untitled Assignment Task",
        //             category: task.category || "General Engineering",
        //             description: task.description || "No full summary description was attached to this project outline.",
        //             budget: task.budget || 0,
        //             deadline: task.deadline || "Open Window",
        //             client_email: task.client_email || "unknown-client@system.local",
        //             status: task.status || "completed",
        //             deliverable_url: task.deliverable_url || "",
        //             createdAt: task.createdAt || task.paid_at || new Date(),
        //             proposals: Array.isArray(task.proposals) ? task.proposals : []
        //         });

        //     } catch (error) {
        //         console.error("❌ Task Audit API Fault:", error);
        //         return res.status(500).json({ message: "Internal server error reading task details." });
        //     }
        // });
        app.get('/task-details/:id', async (req, res) => {
            try {
                const { id } = req.params;

                // 1. Safely normalize and check for empty/undefined values
                const cleanId = id?.toString().trim();
                if (!cleanId || cleanId === 'undefined' || cleanId === '') {
                    return res.status(400).json({ message: "Invalid or missing Task Identifier parameter." });
                }

                // 2. Validate MongoDB ObjectId format before database query
                if (!ObjectId.isValid(cleanId)) {
                    return res.status(400).json({ message: "The provided Task Identifier format is invalid." });
                }

                // 3. Fetch task from DB
                const task = await tasksCollection.findOne({ _id: new ObjectId(cleanId) });

                if (!task) {
                    return res.status(404).json({ message: "The specified task profile could not be found." });
                }

                // 4. Fetch review associated with this task (using ObjectId matching)
                const review = await reviewsCollection.findOne({
                    $or: [
                        { taskId: cleanId },                 // If it was saved as a String
                        { taskId: new ObjectId(cleanId) }    // If it was saved as an ObjectId
                    ]
                });

                // 5. Return sanitized payload with consistent fallback data types and the review
                return res.status(200).json({
                    _id: task._id,
                    title: task.title || "Untitled Assignment Task",
                    category: task.category || "General Engineering",
                    description: task.description || "No full summary description was attached.",
                    budget: Number(task.budget) || 0,
                    deadline: task.deadline || "Open Window",
                    client_email: task.client_email || "",
                    status: task.status || "completed",
                    deliverable_url: task.deliverable_url || "",
                    createdAt: task.createdAt || task.paid_at || new Date(),
                    proposals: Array.isArray(task.proposals) ? task.proposals : [],

                    // Sends the review object, or null if it hasn't been reviewed yet
                    review: review || null
                });

            } catch (error) {
                console.error("❌ Task Audit API Fault:", error);
                return res.status(500).json({ message: "Internal server error reading task details." });
            }
        });
        app.get('/client-payment-history', async (req, res) => {
            try {
                const { email } = req.query;

                console.log("\n==========================================");
                console.log("📥 CLIENT LEDGER: Received GET request /client-payment-history");
                console.log("📧 CLIENT LEDGER: Query Email parameter:", email);

                if (!email) {
                    console.warn("⚠️ CLIENT LEDGER WARNING: Missing email parameter.");
                    return res.status(400).json({ message: "Missing client 'email' query parameter." });
                }

                // DEBUG STEP 1: Find raw documents to check if data fields exist under alternative names
                const rawPaymentsCount = await paymentsCollection.countDocuments({ client_email: email });
                console.log(`📊 DEBUG 1: Raw payments matching 'client_email': ${rawPaymentsCount}`);

                // If zero, check if it's stored under a camelCase field name instead
                if (rawPaymentsCount === 0) {
                    const alternateCount = await paymentsCollection.countDocuments({ clientEmail: email });
                    console.log(`📊 DEBUG 1-ALT: Raw payments matching alternate 'clientEmail': ${alternateCount}`);
                }

                const samplePayments = await paymentsCollection.find({
                    $or: [{ client_email: email }, { clientEmail: email }]
                }).limit(2).toArray();

                console.log("🔍 DEBUG 2: Structural sample of your payments collection fields:", JSON.stringify(samplePayments, null, 2));

                // 3. Robust Execution Pipeline with Fallbacks
                const pipeline = [
                    {
                        $match: {
                            $or: [
                                { client_email: email },
                                { clientEmail: email }
                            ]
                        }
                    },
                    {
                        $addFields: {
                            safe_task_id: { $ifNull: ["$task_id", "$taskId"] },
                            safe_freelancer: { $ifNull: ["$freelancer_email", "$freelancerEmail"] },
                            safe_amount: { $ifNull: ["$amount", "$amountPaid"] },
                            safe_status: { $ifNull: ["$payment_status", "$status"] },
                            // 🛠️ UPDATE THIS LINE to include "$paid_at":
                            safe_date: { $ifNull: ["$paid_at", "$payment_date", "$createdAt", "$date"] }
                        }
                    },
                    {
                        $addFields: {
                            converted_task_id: {
                                $toObjectId: {
                                    $trim: {
                                        input: { $toString: "$safe_task_id" }
                                    }
                                }
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "tasks",
                            localField: "converted_task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                    // Use preserveNullAndEmptyArrays so the row isn't destroyed if the task lookup fails
                    { $unwind: { path: "$taskDetails", preserveNullAndEmptyArrays: true } },
                    {
                        $project: {
                            _id: 0,
                            paymentId: { $ifNull: ["$_id", "N/A"] },
                            taskId: { $ifNull: ["$taskDetails._id", "$safe_task_id"] },
                            taskName: { $ifNull: ["$taskDetails.title", "Unknown / Archived Task Spec"] },
                            freelancerEmail: { $ifNull: ["$safe_freelancer", "Not Assigned"] },
                            amount: { $ifNull: ["$safe_amount", 0] },
                            status: { $ifNull: ["$safe_status", "paid"] },
                            date: { $ifNull: ["$safe_date", null] }
                        }
                    }
                ];

                console.log("⚙️ CLIENT LEDGER: Processing main aggregate pipelines...");
                const paymentHistory = await paymentsCollection.aggregate(pipeline).toArray();
                console.log(`🚀 CLIENT LEDGER SUCCESS: Sending ${paymentHistory.length} records back to client frontend UI.`);
                console.log("==========================================\n");

                // const totalSpent = paymentHistory.reduce((sum, item) => sum + (自由 = Number(item.amount) || 0), 0);
                const totalSpent = paymentHistory.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

                return res.status(200).json({
                    history: paymentHistory,
                    totalSpent
                });

            } catch (error) {
                console.error("❌ CLIENT LEDGER CRITICAL EXCEPTION:", error);
                return res.status(500).json({ message: "Failed to compile client ledger streams." });
            }
        });
        /** 
         * 1. POST / tasks
            * Purpose: Publish a new job block into the database collection.
         */
        app.post('/tasks', async (req, res) => {
            try {
                const { title, category, description, budget, deadline, client_email } = req.body;

                if (!title || !category || !description || !budget || !deadline || !client_email) {
                    return res.status(400).json({ message: "Missing required fields." });
                }

                const newTask = {
                    title,
                    category,
                    description,
                    budget: Number(budget),
                    deadline: new Date(deadline),
                    client_email,
                    status: "open",
                    deliverable_url: null,
                    createdAt: new Date()
                };

                const result = await tasksCollection.insertOne(newTask);
                return res.status(201).json({
                    message: "Task published successfully!",
                    taskId: result.insertedId,
                    task: newTask
                });
            } catch (error) {
                console.error("POST /tasks Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * 2. GET /tasks
         * Purpose: Retrieve tasks with dynamic search, category, status, and budget filter capabilities.
         */
        app.get('/tasks', async (req, res) => {
            try {
                const { email, search, category, status, minBudget, maxBudget } = req.query;
                let query = {};

                if (email) {
                    query.client_email = email;
                }

                if (search) {
                    query.$or = [
                        { title: { $regex: search, $options: 'i' } },
                        { description: { $regex: search, $options: 'i' } }
                    ];
                }

                if (category) {
                    const categoryArray = category.split(',');
                    query.category = { $in: categoryArray.map(cat => new RegExp(`^${cat}$`, 'i')) };
                }

                if (status) {
                    query.status = { $regex: `^${status}$`, $options: 'i' };
                }

                if (minBudget || maxBudget) {
                    query.budget = {};
                    if (minBudget) query.budget.$gte = Number(minBudget);
                    if (maxBudget) query.budget.$lte = Number(maxBudget);
                }

                const tasks = await tasksCollection.find(query).sort({ createdAt: -1 }).toArray();
                return res.status(200).json(tasks);
            } catch (error) {
                console.error("GET /tasks Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
        * 7. GET /tasks/:id
        */
        app.get('/tasks/:id', async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const query = { _id: new ObjectId(id) };
                const task = await tasksCollection.findOne(query);

                if (!task) {
                    return res.status(404).json({ message: "Task not found." });
                }

                return res.status(200).json(task);
            } catch (error) {
                console.error("GET /tasks/:id Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
        * 8. PATCH /api/tasks/:id/edit
        */
        app.patch('/api/tasks/:id/edit', async (req, res) => {
            try {
                const { id } = req.params;
                const { title, description, category, budget } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const filter = { _id: new ObjectId(id) };
                const updateFields = {};
                if (title) updateFields.title = title;
                if (description) updateFields.description = description;
                if (category) updateFields.category = category;
                if (budget) updateFields.budget = Number(budget);

                const updateDoc = { $set: updateFields };
                const result = await tasksCollection.updateOne(filter, updateDoc);

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Task not found." });
                }

                return res.status(200).json({ message: "Task updated cleanly." });
            } catch (error) {
                console.error("PATCH /api/tasks/:id/edit Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * 9. DELETE /tasks/:id
         */
        app.delete('/tasks/:id', async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const query = { _id: new ObjectId(id) };
                const task = await tasksCollection.findOne(query);
                if (!task) {
                    return res.status(404).json({ message: "Task not found." });
                }
                if (task.proposals && task.proposals > 0) {
                    return res.status(400).json({ message: "Action Blocked: Task contains active proposals." });
                }

                await tasksCollection.deleteOne(query);
                return res.status(200).json({ message: "Task removed from collection successfully." });
            } catch (error) {
                console.error("DELETE /tasks/:id Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * POST /proposals
         */
        app.post('/proposals', async (req, res) => {
            try {
                const { taskId, freelancerEmail, proposedBudget, estimatedDays, coverNote } = req.body;

                if (!taskId || !freelancerEmail || !proposedBudget || !estimatedDays || !coverNote) {
                    return res.status(400).json({ message: "Missing required fields." });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const query = { _id: new ObjectId(taskId) };
                const task = await tasksCollection.findOne(query);

                if (!task) {
                    return res.status(404).json({ message: "Task not found." });
                }
                if (task.status?.toLowerCase() !== 'open') {
                    return res.status(400).json({ message: "This task is no longer open." });
                }

                const proposalData = {
                    task_id: new ObjectId(taskId),
                    freelancer_email: freelancerEmail,
                    proposed_budget: Number(proposedBudget),
                    estimated_days: Number(estimatedDays),
                    cover_note: coverNote,
                    status: "pending",
                    submitted_at: new Date()
                };

                const result = await proposalsCollection.insertOne(proposalData);

                await tasksCollection.updateOne(
                    query,
                    { $inc: { proposals: 1 } }
                );

                return res.status(201).json({
                    message: "Proposal submitted successfully!",
                    proposalId: result.insertedId
                });

            } catch (error) {
                console.error("POST /proposals Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * GET /proposals
         */
        app.get('/proposals', async (req, res) => {
            try {
                const { freelancerEmail } = req.query;
                if (!freelancerEmail) {
                    return res.status(400).json({ message: "Missing required 'freelancerEmail' query parameter." });
                }

                const pipeline = [
                    { $match: { freelancer_email: freelancerEmail } },
                    {
                        $lookup: {
                            from: "tasks",
                            localField: "task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                    { $unwind: { path: "$taskDetails", preserveNullAndEmptyArrays: true } },
                    {
                        $project: {
                            _id: 1,
                            task_id: 1,
                            freelancer_email: 1,
                            proposed_budget: 1,
                            estimated_days: 1,
                            cover_note: 1,
                            status: 1,
                            submitted_at: 1,
                            taskTitle: { $ifNull: ["$taskDetails.title", "Unknown Task"] }
                        }
                    },
                    { $sort: { submitted_at: -1 } }
                ];

                const myProposals = await proposalsCollection.aggregate(pipeline).toArray();
                return res.status(200).json(myProposals);
            } catch (error) {
                console.error("GET /proposals Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * GET /proposals/:id
         */
        app.get('/proposals/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const proposal = await proposalsCollection.findOne(query);

                if (!proposal) {
                    return res.status(404).send({ message: "Proposal not found" });
                }

                let structuralTitle = "Unknown Task Title";
                if (proposal.task_id) {
                    const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.task_id) });
                    if (task && task.title) {
                        structuralTitle = task.title;
                    }
                }

                const cleanPayload = {
                    ...proposal,
                    taskTitle: structuralTitle
                };

                res.send(cleanPayload);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Error fetching individual proposal data record" });
            }
        });

        // const { ObjectId } = require('mongodb'); // Ensure this is imported at the top of your backend file

        // ✅ NEW ENDPOINT: Update proposal status to rejected
        app.patch('/proposals/:id/reject', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid proposal ID format." });
                }

                const result = await proposalsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: 'rejected' } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Proposal not found." });
                }

                return res.status(200).json({ message: "Proposal rejected successfully." });
            } catch (error) {
                console.error("PATCH /proposals/:id/reject Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        app.get('/client-proposals', async (req, res) => {
            try {
                const { clientEmail } = req.query;
                if (!clientEmail) {
                    return res.status(400).json({ message: "Missing required 'clientEmail' query parameter." });
                }

                const pipeline = [
                    // 1. Join with the tasks collection to find out who owns the task
                    {
                        $lookup: {
                            from: "tasks",
                            let: { t_id: "$task_id" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $eq: ["$_id", { $toObjectId: "$$t_id" }]
                                        }
                                    }
                                }
                            ],
                            as: "taskDetails"
                        }
                    },
                    // 2. Filter: Only keep proposals where the task belongs to this client
                    // We use an array check instead of $unwind so nothing gets dropped if a task changes status!
                    {
                        $match: {
                            "taskDetails.client_email": clientEmail
                        }
                    },
                    // 3. Format the final output layout safely
                    {
                        $project: {
                            _id: 1,
                            task_id: 1,
                            freelancer_email: 1,
                            proposed_budget: 1,
                            estimated_days: 1,
                            cover_note: 1,
                            status: 1,
                            submitted_at: 1,
                            // Safely extract the title from the joined array without breaking
                            taskTitle: {
                                $ifNull: [
                                    { $arrayElemAt: ["$taskDetails.title", 0] },
                                    "Design a Portfolio for CEO"
                                ]
                            }
                        }
                    },
                    { $sort: { submitted_at: -1 } }
                ];

                // This queries proposals directly, matches via task client_email, and preserves your data!
                const incomingProposals = await proposalsCollection.aggregate(pipeline).toArray();
                return res.status(200).json(incomingProposals);

            } catch (error) {
                console.error("GET /client-proposals Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });
        /**
         * GET /freelancers
         */
        app.get('/freelancers', async (req, res) => {
            try {
                // Use the client reference directly to establish scope safely
                const freelancers = await client.db('skillswap').collection('user').find({
                    role: "freelancer",
                    isBlocked: { $ne: true }
                }).toArray();

                return res.status(200).json(freelancers);
            } catch (error) {
                console.error("GET /freelancers Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * GET /all-proposals-summary
         */
        // -------------------------------------------------------------------------
        // 📋 PUBLIC PROPOSALS SUMMARY API ENDPOINT
        // -------------------------------------------------------------------------
        // -------------------------------------------------------------------------
        // 📋 PUBLIC PROPOSALS SUMMARY API ENDPOINT
        // -------------------------------------------------------------------------
        app.get('/all-proposals-summary', async (req, res) => {
            try {
                const proposalsWithStatus = await proposalsCollection.aggregate([
                    {
                        // 1. Join with the taskCollection
                        $lookup: {
                            from: "taskCollection",       // Make sure this matches your actual MongoDB collection name for tasks
                            localField: "taskId",         // The field name inside proposalsCollection referencing the task
                            foreignField: "_id",          // The identifier field name inside taskCollection (usually _id)
                            as: "taskDetails"
                        }
                    },
                    {
                        // 2. Unwind the array generated by $lookup to make it an object
                        $unwind: {
                            path: "$taskDetails",
                            preserveNullAndEmptyArrays: true // Keeps the proposal even if the task document is missing
                        }
                    },
                    {
                        // 3. Project the fields so the frontend gets exactly what it expects
                        $project: {
                            _id: 1,
                            freelancer_email: 1,
                            // If the task exists, grab its status; otherwise default to "pending"
                            status: { $ifNull: ["$taskDetails.status", "pending"] },
                            // Include any other proposal fields you need here:
                            title: 1,
                            bidAmount: 1
                        }
                    }
                ]).toArray();

                return res.status(200).json(proposalsWithStatus);
            } catch (error) {
                console.error("Aggregation Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });
        // GET: Calculate and rank the Top 3 Freelancers based on ratings
        app.get("/api/top-freelancers", async (req, res) => {
            try {
                // 1. Grab all freelancer records
                // Assumes your freelancers are stored in a accessible endpoint array or MongoDB collection
                // Replace with database query if using native drivers (e.g., await Freelancer.find({}))
                const freelancersResponse = await fetch("http://localhost:8080/freelancers");
                if (!freelancersResponse.ok) {
                    return res.status(500).json({ error: "Failed to collect core freelancer profiles registry." });
                }
                const freelancers = await freelancersResponse.json();

                // 2. Fetch all evaluation reviews
                // Assumes your global reviews collection exists on this endpoint structure
                const reviewsResponse = await fetch("http://localhost:8080/api/reviews");
                let allReviews = [];
                if (reviewsResponse.ok) {
                    allReviews = await reviewsResponse.json();
                }

                // Map over each freelancer to aggregate values
                const rankedFreelancers = freelancers.map(user => {
                    const userEmail = user.email?.trim().toLowerCase();

                    // Filter reviews matching the exact target profile's email address
                    const matchingReviews = allReviews.filter(review =>
                        review.revieweeEmail?.trim().toLowerCase() === userEmail
                    );

                    // Compute total jobs completed (count of review ledgers linked)
                    const totalJobsDone = matchingReviews.length;

                    // Calculate exact average star metric rating matrix
                    let averageRating = 0;
                    if (totalJobsDone > 0) {
                        // If rating is passed down as a quantitative string ("Excellent", "Good"), map it or reduce numbers
                        const sum = matchingReviews.reduce((acc, curr) => {
                            let numericalValue = 5; // Default fallback score

                            if (typeof curr.rating === 'number') {
                                numericalValue = curr.rating;
                            } else if (typeof curr.rating === 'string') {
                                const score = curr.rating.trim().toLowerCase();
                                if (score === 'excellent') numericalValue = 5;
                                else if (score === 'good') numericalValue = 4;
                                else if (score === 'average' || score === 'fair') numericalValue = 3;
                                else if (score === 'poor') numericalValue = 2;
                            }
                            return acc + numericalValue;
                        }, 0);

                        averageRating = sum / totalJobsDone;
                    }

                    return {
                        ...user,
                        totalJobsDone,
                        averageRating
                    };
                });

                // 3. Sort freelancers by performance rating descending, then select top 3
                const topThree = rankedFreelancers
                    .sort((a, b) => b.averageRating - a.averageRating)
                    .slice(0, 3);

                res.json(topThree);

            } catch (error) {
                console.error("Backend TopFreelancers aggregation failed:", error);
                res.status(500).json({ error: "Internal processing error collecting talent rankings." });
            }
        });
        app.get("/api/top-freelancers", async (req, res) => {
            console.log("\n🚀 [BACKEND DIAGNOSTIC] Incoming request to compile Top Rated Freelancers...");

            try {
                // 1. Fetch all basic freelancer accounts
                const freelancersResponse = await fetch("http://localhost:8080/freelancers");
                if (!freelancersResponse.ok) {
                    console.error("❌ [BACKEND DIAGNOSTIC] Failed fetching basic user node list.");
                    return res.status(500).json({ error: "Failed to collect core freelancer profiles registry." });
                }
                const freelancers = await freelancersResponse.json();
                console.log(`📦 [BACKEND DIAGNOSTIC] Loaded ${freelancers.length} freelancers from the database.`);

                // 2. Concurrently fetch and resolve matching profile reviews for each freelancer
                const computedFreelancers = await Promise.all(
                    freelancers.map(async (freelancer) => {
                        let matchingReviews = [];
                        const targetEmail = freelancer.email?.trim().toLowerCase();

                        try {
                            // Pull specific reviews filtered by the freelancer's email address
                            const reviewResponse = await fetch(`http://localhost:8080/api/freelancer-reviews?email=${encodeURIComponent(freelancer.email)}`);
                            if (reviewResponse.ok) {
                                matchingReviews = await reviewResponse.json();
                            }
                        } catch (err) {
                            console.warn(`⚠️ [BACKEND DIAGNOSTIC] Problem querying review maps for ${freelancer.email}:`, err.message);
                        }

                        // Apply text-to-score calculation rating matrix logic 
                        let averageScore = 0;
                        if (matchingReviews && matchingReviews.length > 0) {
                            const totalScore = matchingReviews.reduce((sum, rev) => {
                                const score = RATING_VALUES[rev.rating] || 0;
                                return sum + score;
                            }, 0);

                            // Round off to one decimal point precision
                            averageScore = parseFloat((totalScore / matchingReviews.length).toFixed(1));
                        }

                        console.log(`📊 [BACKEND DIAGNOSTIC] Freelancer: ${freelancer.name} (${freelancer.email}) | Reviews Count: ${matchingReviews.length} | Computed AvgRating: ${averageScore}`);

                        return {
                            ...freelancer,
                            avgRating: averageScore
                        };
                    })
                );

                // 3. Sort freelancers descending based on their computed average ratings
                const topThree = computedFreelancers
                    .sort((a, b) => b.avgRating - a.avgRating)
                    .slice(0, 3);

                console.log("🏆 [BACKEND DIAGNOSTIC] Successfully ranked and calculated Top 3 records:",
                    topThree.map(f => ({ name: f.name, avgRating: f.avgRating }))
                );

                // Return calculated top freelancers matrix collection payload
                res.json(topThree);

            } catch (error) {
                console.error("❌ [BACKEND DIAGNOSTIC] Global fatal process exception:", error);
                res.status(500).json({ error: "Internal processing error collecting talent rankings." });
            }
        });
        /**
         * GET: Aggregate platform statistics totals
         * Pulls collections arrays and reduces total balances dynamically.
         */
        // GET /api/platform-stats
        app.get('/api/platform-stats', async (req, res) => {
            try {
                const db = client.db('skillswap');

                const usersCollection = db.collection('user');
                const tasksCollection = db.collection('tasks');
                const paymentsCollection = db.collection('payments');

                // Total Users
                const totalUsers = await usersCollection.countDocuments();

                // Total Completed Jobs
                const totalJobsDone = await tasksCollection.countDocuments({
                    status: "Completed"
                });

                // Total Payout Completed (sum of all paid amounts)
                const paymentResult = await paymentsCollection.aggregate([
                    {
                        $match: {
                            payment_status: "paid"
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            totalPaymentSum: {
                                $sum: "$amount"
                            }
                        }
                    }
                ]).toArray();

                const totalPaymentSum =
                    paymentResult.length > 0
                        ? paymentResult[0].totalPaymentSum
                        : 0;

                res.status(200).json({
                    success: true,
                    data: {
                        totalUsers,
                        totalJobsDone,
                        totalPaymentSum
                    }
                });

            } catch (error) {
                console.error("Platform Stats Error:", error);
                res.status(500).json({
                    success: false,
                    message: "Failed to fetch platform statistics."
                });
            }
        });
        // PATCH /api/tasks/:id/complete
        // PATCH: http://localhost:8080/api/tasks/:id/complete
        /**
         * PATCH: Transition status field from 'in_progress' to 'Completed'
         * Ensures task is verified, open to edits, and owned by the requesting client.
         */
       // Ensure your Task model is imported at the top of your backend file
// const Task = require("../models/Task"); 

app.patch("/api/tasks/:id/complete", async (req, res) => {
    const { id } = req.params;
    const { email } = req.body; 

    console.log(`\n🏁 [BACKEND DIAGNOSTIC] Request to close task ID: ${id} by Client: ${email}`);

    try {
        // 1. Convert the string ID to a MongoDB ObjectId safely
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid task ID format." });
        }
        const query = { _id: new ObjectId(id) };

        // 2. Fetch task directly from your MongoDB collection
        // Replace 'db' with whatever your database variable name is (e.g., req.app.locals.db)
        const tasksCollection = db.collection('tasks'); 
        const task = await tasksCollection.findOne(query);

        if (!task) {
            return res.status(404).json({ error: "Target task document not found." });
        }

        // 3. Validate current operational status parameters
        if (task.status?.toLowerCase() !== 'in_progress') {
            return res.status(400).json({ error: "Invalid Action: Only tasks currently 'in_progress' can be marked as complete." });
        }

        // 4. Security Check
        const ownerEmail = task.client_email;
        if (!ownerEmail || ownerEmail.trim().toLowerCase() !== email?.trim().toLowerCase()) {
            return res.status(403).json({ error: "Access Denied: You do not have permission to modify this project listing." });
        }

        // 5. Update the status field directly in the collection
        await tasksCollection.updateOne(query, {
            $set: { status: "Completed" }
        });

        console.log(`🎯 [STATUS SYNCHRONIZED] Task ${id} updated to 'Completed' in MongoDB collection.`);
        return res.json({ message: "Task finalized successfully.", status: "Completed" });

    } catch (error) {
        console.error("❌ [BACKEND DIAGNOSTIC] Problem executing complete action status changes:", error.message);
        return res.status(500).json({ error: "Internal server error processing transaction lifecycle." });
    }
});

    } catch (error) {
        console.error("Initialization Error:", error);
    }
}

// Invoke the setup runner safely
run().catch(console.dir);

// Start the server
app.listen(port, () => {
    console.log(`Server listening context safely on port ${port}`);
});