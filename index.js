const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
// const { ObjectId } = require('mongodb');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

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

        // NEW: Creating the payments collection reference since it wasn't there before
        const paymentsCollection = db.collection('payments');

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

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
                console.log("\n==========================================");
                console.log("📥 BACKEND: Received GET request /freelancer-active-projects");
                console.log("📧 BACKEND: Query Email parameter:", email);

                if (!email) {
                    console.warn("⚠️ BACKEND WARNING: Missing email parameter.");
                    return res.status(400).json({ message: "Missing 'email' query parameter." });
                }

                // DEBUG CHECK A: Check if any raw payments exist for this freelancer at all
                const totalPaymentsCount = await paymentsCollection.countDocuments({ freelancer_email: email });
                console.log(`📊 DEBUG A: Total payment rows matching freelancer email "${email}":`, totalPaymentsCount);

                // DEBUG CHECK B: Check if any paid status rows exist for this freelancer
                const paidPayments = await paymentsCollection.find({ freelancer_email: email, payment_status: "paid" }).toArray();
                console.log(`📊 DEBUG B: Total successful 'paid' status rows matching this freelancer:`, paidPayments.length);

                if (paidPayments.length > 0) {
                    console.log("🔍 DEBUG C: Sample payment object task_id values from database:", paidPayments.map(p => ({
                        paymentId: p._id,
                        task_id_raw: p.task_id,
                        type_of_task_id: typeof p.task_id
                    })));
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
                                        input: { $toString: "$task_id" } // 🛠️ SAFE FIX: Force conversion to string before trimming
                                    }
                                }
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "tasks", // ⚠️ Ensure this matches your exact MongoDB collection name case-sensitive
                            localField: "converted_task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                    // Temporarily comment out unwind to see if lookup fails to find a matching task item
                    // { $unwind: "$taskDetails" },
                ];

                console.log("⚙️ BACKEND: Running raw testing aggregation pipeline (without unwind filter)...");
                const testAggregation = await paymentsCollection.aggregate(pipeline).toArray();

                console.log("📦 DEBUG D: Result size before unwinding:", testAggregation.length);
                if (testAggregation.length > 0) {
                    console.log("🔍 DEBUG E: Verification of Joined taskDetails arrays:", testAggregation.map(item => ({
                        paymentId: item._id,
                        hasTaskDetailsMatched: item.taskDetails.length > 0,
                        taskDetailsArrayLength: item.taskDetails.length
                    })));
                }

                // Final safe aggregation pipeline for output production
                const finalPipeline = [
                    { $match: { freelancer_email: email, payment_status: "paid" } },
                    {
                        $addFields: {
                            converted_task_id: {
                                $toObjectId: {
                                    $trim: {
                                        input: { $toString: "$task_id" } // 🛠️ SAFE FIX: Force conversion to string here too
                                    }
                                }
                            }
                        }
                    },
                    { $lookup: { from: "tasks", localField: "converted_task_id", foreignField: "_id", as: "taskDetails" } },
                    { $match: { "taskDetails.0": { $exists: true } } }, // Drop rows where task lookup failed
                    { $unwind: "$taskDetails" },
                    { $sort: { "taskDetails.createdAt": -1 } },
                    {
                        $project: {
                            _id: 0,
                            paymentId: "$_id",
                            transactionId: "$transaction_id",
                            amountPaid: "$amount",
                            taskId: "$taskDetails._id",
                            title: "$taskDetails.title",
                            category: "$taskDetails.category",
                            description: "$taskDetails.description",
                            deadline: "$taskDetails.deadline",
                            clientEmail: "$client_email",
                            status: { $toLower: "$taskDetails.status" },
                            deliverableUrl: "$taskDetails.deliverable_url"
                        }
                    }
                ];

                const activeProjects = await paymentsCollection.aggregate(finalPipeline).toArray();
                console.log("🚀 BACKEND RESPONSE: Final processed matching rows returning to client:", activeProjects.length);
                console.log("==========================================\n");

                return res.status(200).json(activeProjects);
            } catch (error) {
                console.error("❌ BACKEND ERROR EXCEPTION:", error);
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

        const { ObjectId } = require('mongodb'); // Ensure this is imported at the top of your backend file

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
        /**
         * GET /client-proposals
         */
        // app.get('/client-proposals', async (req, res) => {
        //     try {
        //         const { clientEmail } = req.query;
        //         if (!clientEmail) {
        //             return res.status(400).json({ message: "Missing required 'clientEmail' query parameter." });
        //         }

        //         // 1. Get ALL tasks owned by this client (no matter if status is open, in_progress, etc.)
        //         const clientTasks = await tasksCollection.find({ client_email: clientEmail }).toArray();

        //         // Convert all task ObjectIds into string formats for robust matching
        //         const clientTaskIdsStrings = clientTasks.map(task => task._id.toString());

        //         // 2. Fetch all proposals matching those specific task IDs
        //         const pipeline = [
        //             {
        //                 $match: {
        //                     $expr: {
        //                         $in: [{ $toString: "$task_id" }, clientTaskIdsStrings]
        //                     }
        //                 }
        //             },
        //             // 3. Lookup the task details just to grab the title safely
        //             {
        //                 $lookup: {
        //                     from: "tasks",
        //                     let: { t_id: "$task_id" },
        //                     pipeline: [
        //                         {
        //                             $match: {
        //                                 $expr: { $eq: ["$_id", { $toObjectId: "$$t_id" }] }
        //                             }
        //                         }
        //                     ],
        //                     as: "taskDetails"
        //                 }
        //             },
        //             // 4. Project the final payload structure safely
        //             {
        //                 $project: {
        //                     _id: 1,
        //                     task_id: 1,
        //                     freelancer_email: 1,
        //                     proposed_budget: 1,
        //                     estimated_days: 1,
        //                     cover_note: 1,
        //                     status: 1,
        //                     submitted_at: 1,
        //                     taskTitle: {
        //                         $ifNull: [
        //                             { $arrayElemAt: ["$taskDetails.title", 0] },
        //                             "Design a Portfolio for CEO" // Graceful fallback
        //                         ]
        //                     }
        //                 }
        //             },
        //             { $sort: { submitted_at: -1 } }
        //         ];

        //         const incomingProposals = await proposalsCollection.aggregate(pipeline).toArray();
        //         return res.status(200).json(incomingProposals);

        //     } catch (error) {
        //         console.error("GET /client-proposals Error:", error);
        //         return res.status(500).json({ message: "Internal server error." });
        //     }
        // });
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
                const usersCollection = db.collection('user');
                const freelancers = await usersCollection.find({
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
        app.get('/all-proposals-summary', async (req, res) => {
            try {
                const proposals = await proposalsCollection.find({}).toArray();
                return res.status(200).json(proposals);
            } catch (error) {
                return res.status(500).json({ message: "Internal server error." });
            }
        });

    } catch (error) {
        console.error("Initialization Error:", error);
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});