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
        app.get('/tasks', async (req, res) => {
            try {
                const { email } = req.query;
                let query = {};

                if (email) {
                    query.client_email = email;
                }

                const tasks = await tasksCollection.find(query).sort({ createdAt: -1 }).toArray();
                return res.status(200).json(tasks);
            } catch (error) {
                console.error("GET /api/tasks Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /* 3. PATCH /api/tasks/:id/status
        * Purpose: Update task status (e.g., changing from 'open' to 'in-progress').
        */
        app.patch('/api/tasks/:id/status', async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;

                if (!status) {
                    return res.status(400).json({ message: "Status string is required." });
                }

                const filter = { _id: new ObjectId(id) };
                const updateDoc = { $set: { status: status } };

                const result = await tasksCollection.updateOne(filter, updateDoc);
                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Task not found." });
                }

                return res.status(200).json({ message: `Task status updated to ${status}.` });
            } catch (error) {
                console.error("PATCH /api/tasks/:id/status Error:", error);
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



    } catch (error) {
        console.error("Initialization Error:", error);
    }
    // The finally block is left empty so the connection remains open for your server routes!
}
run().catch(console.dir);

// Base Route
app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});





