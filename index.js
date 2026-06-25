const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
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
        /**
         * 1. POST /tasks
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

        /**
         * GET /client-proposals
         */
        app.get('/client-proposals', async (req, res) => {
            try {
                const { clientEmail } = req.query;
                if (!clientEmail) {
                    return res.status(400).json({ message: "Missing required 'clientEmail' query parameter." });
                }

                const pipeline = [
                    {
                        $lookup: {
                            from: "tasks",
                            localField: "task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                    { $unwind: "$taskDetails" },
                    { $match: { "taskDetails.client_email": clientEmail } },
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
                            taskTitle: "$taskDetails.title"
                        }
                    },
                    { $sort: { submitted_at: -1 } }
                ];

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