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
        app.post('/api/tasks', async (req, res) => {
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



/**
         * 2. GET /api/tasks
         * Purpose: Retrieve tasks. Can pass an optional query parameter `email` to filter by client.
         */
        app.get('/api/tasks', async (req, res) => {
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

        /**
         * 3. PATCH /api/tasks/:id/status
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
         * 4. PATCH /api/tasks/:id/deliverable
         * Purpose: Save the final submission URL when a freelancer finishes a task.
         */
        app.patch('/api/tasks/:id/deliverable', async (req, res) => {
            try {
                const { id } = req.params;
                const { deliverable_url } = req.body;

                if (!deliverable_url) {
                    return res.status(400).json({ message: "Deliverable URL is required." });
                }

                const filter = { _id: new ObjectId(id) };
                const updateDoc = { $set: { deliverable_url: deliverable_url } };

                const result = await tasksCollection.updateOne(filter, updateDoc);
                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "Task not found." });
                }

                return res.status(200).json({ message: "Deliverable URL submitted successfully." });
            } catch (error) {
                console.error("PATCH /api/tasks/:id/deliverable Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });

        /**
         * 5. DELETE /api/tasks/:id
         * Purpose: Delete a task entry from the database.
         */
        app.delete('/api/tasks/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const filter = { _id: new ObjectId(id) };

                const result = await tasksCollection.deleteOne(filter);
                if (result.deletedCount === 0) {
                    return res.status(404).json({ message: "Task not found." });
                }

                return res.status(200).json({ message: "Task deleted from collection successfully." });
            } catch (error) {
                console.error("DELETE /api/tasks/:id Error:", error);
                return res.status(500).json({ message: "Internal server error." });
            }
        });