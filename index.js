const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

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

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        /**
         * 1. POST /api/tasks
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
                console.error("POST /api/tasks Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });
        /**
         * 2. GET /api/tasks
         * Purpose: Retrieve tasks. Can pass an optional query parameter `email` to filter by client.
         */
        /**
 * 2. GET /tasks
 * Purpose: Retrieve tasks with dynamic search, category, status, and budget filter capabilities.
 */
        app.get('/tasks', async (req, res) => {
            try {
                const { email, search, category, status, minBudget, maxBudget } = req.query;
                let query = {};

                // Filter by client email if provided
                if (email) {
                    query.client_email = email;
                }

                // 1. Text Search Filter (Case-insensitive matching across Title or Description)
                if (search) {
                    query.$or = [
                        { title: { $regex: search, $options: 'i' } },
                        { description: { $regex: search, $options: 'i' } }
                    ];
                }

                // 2. Category Filter (Supports single string or comma-separated lists from frontend)
                if (category) {
                    const categoryArray = category.split(',');
                    query.category = { $in: categoryArray.map(cat => new RegExp(`^${cat}$`, 'i')) };
                }

                // 3. Status Filter
                if (status) {
                    query.status = { $regex: `^${status}$`, $options: 'i' };
                }

                // 4. Budget Range Filter
                if (minBudget || maxBudget) {
                    query.budget = {};
                    if (minBudget) query.budget.$gte = Number(minBudget);
                    if (maxBudget) query.budget.$lte = Number(maxBudget);
                }

                // Fetch data sorted by newest submissions first
                const tasks = await tasksCollection.find(query).sort({ createdAt: -1 }).toArray();
                return res.status(200).json(tasks);
            } catch (error) {
                console.error("GET /tasks Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
        * 7. GET /tasks/:id
        * Purpose: Retrieving a single task document by its Id.
        */
        app.get('/tasks/:id', async (req, res) => {
            try {
                const { id } = req.params;

                // Ensure the ID parameter is valid for MongoDB conversion
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
        * Purpose: Updating a task's editable field attributes.
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
         * Purpose: Completely removing a task from the collection .
         */
        app.delete('/tasks/:id', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                const query = { _id: new ObjectId(id) };

                // Safety check to mirror your frontend rule (preventing deleting tasks with proposals)
                const task = await tasksCollection.findOne(query);
                if (!task) {
                    return res.status(404).json({ message: "Task not found." });
                }
                if (task.proposals && task.proposals > 0) {
                    return res.status(400).json({ message: "Action Blocked: Task contains active proposals." });
                }

                const result = await tasksCollection.deleteOne(query);
                return res.status(200).json({ message: "Task removed from collection successfully." });
            } catch (error) {
                console.error("DELETE /tasks/:id Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        // proposals
        app.post('/proposals', async (req, res) => {
            try {
                const { taskId, freelancerEmail, proposedBudget, estimatedDays, coverNote } = req.body;

                // Validation check
                if (!taskId || !freelancerEmail || !proposedBudget || !estimatedDays || !coverNote) {
                    return res.status(400).json({ message: "Missing required fields." });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).json({ message: "Invalid Task ID format." });
                }

                // Verify the task exists and is open
                const query = { _id: new ObjectId(taskId) };
                const task = await tasksCollection.findOne(query);

                if (!task) {
                    return res.status(404).json({ message: "Task not found." });
                }
                if (task.status?.toLowerCase() !== 'open') {
                    return res.status(400).json({ message: "This task is no longer open." });
                }

                // Construct proposal data using your exact database fields
                const proposalData = {
                    task_id: new ObjectId(taskId),
                    freelancer_email: freelancerEmail,
                    proposed_budget: Number(proposedBudget),
                    estimated_days: Number(estimatedDays),
                    cover_note: coverNote,
                    status: "pending",
                    submitted_at: new Date()
                };

                // 1. Save proposal into database
                const result = await proposalsCollection.insertOne(proposalData);

                // 2. Add 1 to the proposal count of this task
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
         * Purpose: Retrieve proposals filtered by freelancerEmail query parameter.
         * Combines proposal data with task details to get the Task Title using an aggregation pipeline.
         */
        app.get('/proposals', async (req, res) => {
            try {
                const { freelancerEmail } = req.query;

                if (!freelancerEmail) {
                    return res.status(400).json({
                        message: "Missing required 'freelancerEmail' query parameter."
                    });
                }

                // Match by email, look up task title from tasks collection, and sort by most recent
                const pipeline = [
                    {
                        $match: { freelancer_email: freelancerEmail }
                    },
                    {
                        $lookup: {
                            from: "tasks",
                            localField: "task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                    {
                        $unwind: {
                            path: "$taskDetails",
                            preserveNullAndEmptyArrays: true // Prevents dropping proposals if a task was somehow lost
                        }
                    },
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
                            taskTitle: { $ifNull: ["$taskDetails.title", "Unknown Task"] } // maps task title smoothly for frontend
                        }
                    },
                    {
                        $sort: { submitted_at: -1 }
                    }
                ];

                const myProposals = await proposalsCollection.aggregate(pipeline).toArray();
                return res.status(200).json(myProposals);

            } catch (error) {
                console.error("GET /proposals Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        app.get('/proposals/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };

                // 1. Get the raw proposal
                const proposal = await proposalsCollection.findOne(query);

                if (!proposal) {
                    return res.status(404).send({ message: "Proposal not found" });
                }

                // 2. Go find the associated task's title using the task_id
                let structuralTitle = "Unknown Task Title";
                if (proposal.task_id) {
                    const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.task_id) });
                    if (task && task.title) {
                        structuralTitle = task.title;
                    }
                }

                // 3. Combine them together so the frontend gets exactly what it's asking for
                const cleanPayload = {
                    ...proposal,
                    taskTitle: structuralTitle // This matches your frontend page perfectly!
                };

                res.send(cleanPayload);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Error fetching individual proposal data record" });
            }
        });

        app.get('/client-proposals', async (req, res) => {
            try {
                const { clientEmail } = req.query;

                if (!clientEmail) {
                    return res.status(400).json({
                        message: "Missing required 'clientEmail' query parameter."
                    });
                }

                const pipeline = [
                    {
                        // 1. Join with the tasks collection using task_id fields
                        $lookup: {
                            from: "tasks",
                            localField: "task_id",
                            foreignField: "_id",
                            as: "taskDetails"
                        }
                    },
                    {
                        // 2. Flatten the joined task array
                        $unwind: "$taskDetails"
                    },
                    {
                        // 3. Filter for tasks created by this specific client
                        // Your tasks route uses 'client_email', so we match that here!
                        $match: {
                            "taskDetails.client_email": clientEmail
                        }
                    },
                    {
                        // 4. Clean up layout fields to map seamlessly to your React frontend UI
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
                    {
                        // 5. Sort by newest submissions first
                        $sort: { submitted_at: -1 }
                    }
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
 * Purpose: Pull all user profiles whose role is set to freelancer from the database.
 */
        app.get('/freelancers', async (req, res) => {
            try {
                // Better-Auth saves records under the default 'user' or 'users' collection name
                const usersCollection = db.collection('user');

                // Find users that match your role condition and aren't blocked
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
         * Purpose: Fetch all basic proposals to figure out job metrics metrics on browse page
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

// Base Route
app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});


