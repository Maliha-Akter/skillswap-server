const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
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

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`))
// verify token function
const verifyToken = async (req, res, next) => {
    const authHeader = req?.headers?.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: "Unauthorized: Missing Token" });
    }
    const token = authHeader.split(" ")[1];

    try {
        const { payload } = await jwtVerify(token, JWKS);
        req.user = payload;
        next();
    } catch (error) {
        console.error("JWT Verification Error:", error.message);
        return res.status(403).json({ message: "Forbidden: Invalid Token" });
    }
};

async function run() {
    try {
        // 1. Establishing database connection safely
        // await client.connect();

        // 2. Selecting database and establish collection references
        const db = client.db('skillswap');
        const tasksCollection = db.collection('tasks');
        const proposalsCollection = db.collection('proposals');
        const paymentsCollection = db.collection('payments');
        const reviewsCollection = db.collection('reviews');
        const usersCollection = db.collection('user');

        // await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");


        // -------------------------------------------------------------------------
        // ADMIN PART
        // -------------------------------------------------------------------------
        const authAdmin = async (req, res, next) => {
            try {
                const userEmail = req.user?.email;
                console.log("==> [BACKEND AUTH] Checking verification header for email:", userEmail);

                if (!userEmail) {
                    return res.status(401).json({ message: "Unauthorized: Missing identity header." });
                }

                const envAdminEmails = process.env.ADMIN_EMAILS
                    ? process.env.ADMIN_EMAILS.split(',').map(email => email.trim().toLowerCase())
                    : [];

                const incomingEmailLower = userEmail.toLowerCase();

                if (envAdminEmails.includes(incomingEmailLower)) {
                    console.log(`==> [BACKEND AUTH] Authorized master access via environment mapping rule for: ${userEmail}`);
                    return next();
                }

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
        app.get('/api/admin/users', verifyToken, authAdmin, async (req, res) => {
            try {
                console.log("==> [TRACE 5: ROUTE REACHED] Request bypassed both middlewares safely!");

                const { search, role } = req.query;
                console.log(`==> [TRACE 6: ROUTE PARAMS] Search Query: "${search || ''}", Filtered Role: "${role || ''}"`);

                let query = {};

                if (search) {
                    query.$or = [
                        { name: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } }
                    ];
                }

                if (role && role !== 'all') {
                    query.role = { $regex: `^${role}$`, $options: 'i' };
                }

                console.log("==> [TRACE 7: MONGO EXECUTION] Query Filter Object:", JSON.stringify(query));
                console.log("==> [TRACE 7a: TARGET COLLECTION REFERENCE]:", usersCollection.collectionName);

                const users = await usersCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                console.log(`==> [TRACE 8: MONGO RESOLVED] Query completed. Record count found: ${users.length}`);

                return res.status(200).json({
                    success: true,
                    data: users
                });
            } catch (error) {
                console.error("==> [TRACE ERROR: ROUTE CRASHED] GET /api/admin/users:", error);
                return res.status(500).json({
                    success: false,
                    message: "Failed to load platform accounts collection.",
                    error: error.message
                });
            }
        });

        app.patch('/api/admin/users/:id/block', verifyToken, authAdmin, async (req, res) => {
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

        app.get("/api/admin/tasks", verifyToken, authAdmin, async (req, res) => {
            try {
                const { search, categories, status, minBudget, maxBudget } = req.query;

                console.log("==================================================");
                console.log("==> [INCOMING REQ] GET /api/admin/tasks");
                console.log("    Raw Query Params:", { search, categories, status, minBudget, maxBudget });

                let query = {};

                if (search) {
                    query.title = { $regex: search, $options: "i" };
                }
                if (categories) {
                    const categoryList = categories.split(",");
                    if (categoryList.length > 0 && categoryList[0] !== "") {
                        query.category = { $in: categoryList };
                    }
                }

                if (status && status.toLowerCase() !== "all") {
                    query.status = { $regex: new RegExp(`^${status}$`, "i") };
                }

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

        app.delete("/api/admin/tasks/:id", verifyToken, authAdmin, async (req, res) => {
            try {
                const { id } = req.params;

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

        app.get('/api/admin/overview-stats', verifyToken, authAdmin, async (req, res) => {
            try {
                console.log("==> [BACKEND OVERVIEW] Aggregating multi-collection dataset streams...");

                // 1. Fetching  Counts and Totals
                const totalUsers = await usersCollection.countDocuments({});
                const totalTasks = await tasksCollection.countDocuments({});
                const activeTasks = await tasksCollection.countDocuments({ status: "in_progress" });
                const completedTasks = await tasksCollection.countDocuments({ status: "Completed" });
                const pendingProposals = await proposalsCollection.countDocuments({ status: "pending" });
                const blockedUsers = await usersCollection.countDocuments({ isBlocked: true });
                const successfulPayments = await paymentsCollection.countDocuments({ payment_status: "paid" });

                // 2. Computing Total Financial Revenue
                const revenueAggregation = await paymentsCollection.aggregate([
                    { $match: { payment_status: "paid" } },
                    { $group: { _id: null, total: { $sum: "$amount" } } }
                ]).toArray();
                const totalRevenue = revenueAggregation[0]?.total || 0;

                // 3. Building Task Distribution Status Chart
                const todoCount = await tasksCollection.countDocuments({ status: "todo" });
                const inProgressCount = await tasksCollection.countDocuments({ status: "in_progress" });
                const doneCount = await tasksCollection.countDocuments({ status: "completed" });

                // 4. Generating Last 6 Months/Days Revenue Points Timeline
                const recentPaymentsList = await paymentsCollection.find({ payment_status: "paid" })
                    .sort({ paid_at: -1 })
                    .limit(6)
                    .toArray();

                const revenueChart = recentPaymentsList.map(pay => ({
                    date: pay.paid_at ? new Date(pay.paid_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recent',
                    amount: pay.amount || 0
                })).reverse();

                if (revenueChart.length === 0) {
                    revenueChart.push({ date: 'Base', amount: 0 });
                }

                // 5. Fetching Recent Activity Feed Document Lists
                const recentTasks = await tasksCollection.find({}).sort({ _id: -1 }).limit(5).toArray();
                const recentUsers = await usersCollection.find({}).sort({ _id: -1 }).limit(5).toArray();
                const recentPayments = await paymentsCollection.find({}).sort({ paid_at: -1 }).limit(5).toArray();

                // 6. Returning standard structured response object wrapper
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
        // FREELANCER PART
        // -------------------------------------------------------------------------
        app.get('/api/freelancer/overview-stats', async (req, res) => {
            try {
                const freelancerEmail = req.headers['user-email'];
                if (!freelancerEmail) {
                    return res.status(400).json({ success: false, message: "Identification header missing." });
                }

                console.log(`==> [FREELANCER OVERVIEW] Syncing dataset for: ${freelancerEmail}`);

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

                const acceptedBids = await proposalsCollection.find({
                    freelancer_email: freelancerEmail,
                    status: { $regex: /^accepted$/i }
                }).toArray();

                const freelancerTaskIds = acceptedBids.map(bid => bid.task_id);

                const completedTasksAggregation = await tasksCollection.aggregate([
                    {
                        $match: {
                            _id: { $in: freelancerTaskIds },
                            status: "Completed" 
                        }
                    },
                    { $group: { _id: null, total: { $sum: "$budget" } } }
                ]).toArray();

                const totalEarnings = completedTasksAggregation[0]?.total || 0;

                const completedTasksList = await tasksCollection.find({
                    _id: { $in: freelancerTaskIds },
                    status: "Completed"
                })
                    .sort({ completedAt: -1 }) 
                    .limit(6)
                    .toArray();

                const earningsChart = completedTasksList.map(task => ({
                    date: task.completedAt ? new Date(task.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recent',
                    amount: task.budget || 0
                })).reverse();

                if (earningsChart.length === 0) {
                    earningsChart.push({ date: 'Initiated', amount: 0 });
                }

                const recentProposalsRaw = await proposalsCollection.find({ freelancer_email: freelancerEmail })
                    .sort({ submitted_at: -1 }) 
                    .limit(5)
                    .toArray();

                const recentProposals = await Promise.all(recentProposalsRaw.map(async (prop) => {
                    const taskInfo = await tasksCollection.findOne({ _id: prop.task_id });
                    return {
                        _id: prop._id,
                        taskTitle: taskInfo ? taskInfo.title : "Unknown Assignment Brief",
                        bidAmount: prop.proposed_budget, 
                        coverLetter: prop.cover_note,     
                        status: prop.status
                    };
                }));

                const activeContracts = await tasksCollection.find({
                    _id: { $in: freelancerTaskIds },
                    status: { $ne: "Completed" }  
                })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray();

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
        app.get('/api/client/overview-stats', verifyToken, async (req, res) => {
            try {
                const clientEmail = req.user.email;
                if (!clientEmail) {
                    return res.status(400).json({ success: false, message: "Identification header missing." });
                }

                console.log(`==> [CLIENT OVERVIEW] Syncing dataset for: ${clientEmail}`);

                const totalTasks = await tasksCollection.countDocuments({ client_email: clientEmail });

                const openTasks = await tasksCollection.countDocuments({
                    client_email: clientEmail,
                    status: { $regex: /^open$/i }
                });

                const tasksInProgress = await tasksCollection.countDocuments({
                    client_email: clientEmail,
                    status: { $regex: /^in_progress$/i }
                });

                const completedExpenditure = await tasksCollection.aggregate([
                    {
                        $match: {
                            client_email: clientEmail,
                            status: "Completed"
                        }
                    },
                    { $group: { _id: null, total: { $sum: "$budget" } } }
                ]).toArray();

                const totalSpent = completedExpenditure[0]?.total || 0;

                const recentTasks = await tasksCollection.find({ client_email: clientEmail })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray();

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

        app.get('/api/tasks/featured-open', async (req, res) => {
            try {
                const featuredTasks = await tasksCollection.find({
                    status: { $regex: /^open$/i }
                })
                    .sort({ createdAt: -1 })
                    .limit(6)
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

        app.post('/api/reviews', verifyToken, async (req, res) => {
            try {
                const { taskId, reviewerEmail, revieweeEmail, rating, comment } = req.body;

                if (!taskId || !reviewerEmail || !revieweeEmail || !rating || !comment) {
                    return res.status(400).json({ message: "All fields are required." });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const taskOId = new ObjectId(taskId);

                const existingReview = await reviewsCollection.findOne({ taskId: taskOId });
                if (existingReview) {
                    return res.status(400).json({ message: "This task has already been reviewed." });
                }

                const reviewRecord = {
                    taskId: taskOId,
                    reviewerEmail,
                    revieweeEmail,
                    rating,
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

        app.get('/api/reviews', verifyToken, async (req, res) => {
            try {
                const { taskId } = req.query;

                if (!taskId) {
                    return res.status(400).json({ message: "taskId query parameter is required." });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const taskOId = new ObjectId(taskId);

                const review = await reviewsCollection.findOne({ taskId: taskOId });

                const acceptedProposal = await proposalsCollection.findOne({
                    $or: [
                        { task_id: taskOId },
                        { task_id: taskId }
                    ],
                    status: { $in: ['accepted', 'approved', 'Accepted', 'Approved'] }
                });

                console.log("=== Debugging Review Pipeline ===");
                console.log("Target Task ID:", taskId);
                console.log("Found Proposal Document:", acceptedProposal);

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

        app.get('/api/freelancer-reviews', async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Email query parameter is required." });
                }

                const reviews = await reviewsCollection.find({ revieweeEmail: email }).toArray();

                return res.status(200).json(reviews);
            } catch (error) {
                console.error("GET /api/freelancer-reviews Error:", error);
                return res.status(500).json({ message: "Internal server error retrieving profile reviews." });
            }
        });
        
        app.get('/tasks/:id/proposals', verifyToken, async (req, res) => {
            try {
                const taskId = req.params.id;

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format parameters." });
                }

                const taskOId = new ObjectId(taskId);

                const query = { task_id: taskOId };

                const proposals = await proposalsCollection
                    .find(query)
                    .sort({ submitted_at: -1 }) 
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
    
        app.get('/payments', verifyToken, authAdmin, async (req, res) => {
            try {
                console.log("==> [BACKEND] Fetching absolute Stripe payment ledger items...");
                const payments = await paymentsCollection
                    .find({})
                    .sort({ paid_at: -1 }) 
                    .toArray();

                console.log(`==> [BACKEND SUCCESS] Transmitted ${payments.length} transaction records.`);

                return res.status(200).json(payments);
            } catch (error) {
                console.error("❌ ==> [BACKEND TRANSACTIONS ERROR]:", error);
                return res.status(500).json({
                    success: false,
                    message: "Internal cluster exception reading database transactions matrix."
                });
            }
        });
        
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
        app.get('/freelancer-active-projects', verifyToken, async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Missing 'email' query parameter." });
                }
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
        app.get('/freelancer-earnings', verifyToken, async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Missing 'email' query parameter." });
                }

                const payments = await paymentsCollection.find({
                    freelancer_email: email,
                    payment_status: "paid"
                }).toArray();

                let totalEarned = 0;
                const paymentCount = payments.length;

                const monthlyTotals = {
                    Jan: 0, Feb: 0, Mar: 0, Apr: 0, May: 0, Jun: 0,
                    Jul: 0, Aug: 0, Sep: 0, Oct: 0, Nov: 0, Dec: 0
                };

                const history = [];

                for (const payment of payments) {
                    const amount = payment.amount || 0;
                    totalEarned += amount;

                    if (payment.paid_at) {
                        const dateObj = new Date(payment.paid_at);
                        const monthName = dateObj.toLocaleString('en-US', { month: 'short' }); // e.g., "Jun"
                        if (monthlyTotals[monthName] !== undefined) {
                            monthlyTotals[monthName] += amount;
                        }
                    }

                    let taskTitle = "Assignment Project";
                    try {
                        if (payment.task_id) {
                            const task = await tasksCollection.findOne({ _id: new ObjectId(payment.task_id.toString().trim()) });
                            if (task) {
                                taskTitle = task.title;
                            }
                        }
                    } catch (err) {
                        console.error("Task look up skipped or failed for ID:", payment.task_id);
                    }

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

                const baseMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const chartData = baseMonths.map(month => ({
                    name: month,
                    earnings: monthlyTotals[month]
                }));

                history.sort((a, b) => new Date(b.date) - new Date(a.date));

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

        app.patch('/tasks/:id/submit-deliverable', verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const { deliverableUrl } = req.body;

                if (!deliverableUrl) {
                    return res.status(400).json({ message: "A valid submission reference link is required." });
                }
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid project identifier provided." });
                }

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
        
        app.get('/task-details/:id', verifyToken, async (req, res) => {
            try {
                const { id } = req.params;
                const cleanId = id?.toString().trim();
                if (!cleanId || cleanId === 'undefined' || cleanId === '') {
                    return res.status(400).json({ message: "Invalid or missing Task Identifier parameter." });
                }

                if (!ObjectId.isValid(cleanId)) {
                    return res.status(400).json({ message: "The provided Task Identifier format is invalid." });
                }

                const task = await tasksCollection.findOne({ _id: new ObjectId(cleanId) });

                if (!task) {
                    return res.status(404).json({ message: "The specified task profile could not be found." });
                }

                const review = await reviewsCollection.findOne({
                    $or: [
                        { taskId: cleanId },                 // If it was saved as a String
                        { taskId: new ObjectId(cleanId) }    // If it was saved as an ObjectId
                    ]
                });

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
        app.get('/client-payment-history', verifyToken, async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).json({ message: "Missing client 'email' query parameter." });
                }

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
                    // 🟥 REMOVED: { $unwind: ... } is deleted to prevent duplicating rows
                    {
                        $project: {
                            _id: 0,
                            paymentId: { $ifNull: ["$_id", "N/A"] },
                            // Grab the first element from the lookup array safely 👇
                            taskId: {
                                $ifNull: [
                                    { $arrayElemAt: ["$taskDetails._id", 0] },
                                    "$safe_task_id"
                                ]
                            },
                            taskName: {
                                $ifNull: [
                                    { $arrayElemAt: ["$taskDetails.title", 0] },
                                    "Unknown / Archived Task Spec"
                                ]
                            },
                            freelancerEmail: { $ifNull: ["$safe_freelancer", "Not Assigned"] },
                            amount: { $ifNull: ["$safe_amount", 0] },
                            status: { $ifNull: ["$safe_status", "paid"] },
                            date: { $ifNull: ["$safe_date", null] }
                        }
                    }
                ];

                const paymentHistory = await paymentsCollection.aggregate(pipeline).toArray();
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
        app.post('/tasks', verifyToken, async (req, res) => {
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
                const { email, search, category, status, minBudget, maxBudget, page, limit } = req.query;
                let query = {};

                // Parse pagination properties with fallback defaults
                const currentPage = Math.max(parseInt(page, 10) || 1, 1);
                const limitCount = Math.max(parseInt(limit, 10) || 9, 1); // Defaults to a max count of 9 documents
                const skipCount = (currentPage - 1) * limitCount;

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

                // Count match states asynchronously for navigation layouts
                const totalDocuments = await tasksCollection.countDocuments(query);
                const totalPages = Math.ceil(totalDocuments / limitCount) || 1;

                // Fetch limited documents matching the current page window
                const tasks = await tasksCollection.find(query)
                    .sort({ createdAt: -1 })
                    .skip(skipCount)
                    .limit(limitCount)
                    .toArray();

                // Return structured dataset properties
                return res.status(200).json({
                    tasks,
                    totalPages,
                    currentPage,
                    totalDocuments
                });
            } catch (error) {
                console.error("GET /tasks Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
        * 7. GET /tasks/:id
        */
        app.get('/tasks/:id', verifyToken, async (req, res) => {
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
        app.patch('/api/tasks/:id/edit', verifyToken, async (req, res) => {
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
        app.delete('/tasks/:id', verifyToken, async (req, res) => {
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
        app.post('/proposals', verifyToken, async (req, res) => {
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
        app.get('/proposals', verifyToken, async (req, res) => {
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
        app.get('/proposals/:id', verifyToken, async (req, res) => {
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
        app.patch('/proposals/:id/reject', verifyToken, async (req, res) => {
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

        app.get('/client-proposals', verifyToken, async (req, res) => {
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
                const freelancersResponse = await fetch(`${process.env.SERVER_URL}/freelancers`);
                if (!freelancersResponse.ok) {
                    return res.status(500).json({ error: "Failed to collect core freelancer profiles registry." });
                }
                const freelancers = await freelancersResponse.json();

                // 2. Fetch all evaluation reviews
                // Assumes your global reviews collection exists on this endpoint structure
                const reviewsResponse = await fetch("${process.env.SERVER_URL}/api/reviews");
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
                const freelancersResponse = await fetch(`${process.env.SERVER_URL}/freelancers`);
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
                            const reviewResponse = await fetch(`${process.env.SERVER_URL}/api/freelancer-reviews?email=${encodeURIComponent(freelancer.email)}`);
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
        app.patch("/api/tasks/:id/complete", verifyToken, async (req, res) => {
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
app.get('/', (req, res) => {
  res.send('Skillswap Server is running smoothly!');
});
// Start the server
app.listen(port, () => {
    console.log(`Server listening context safely on port ${port}`);
});