require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Game = require('./models/Game');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// MongoDB connection -  COMBINE ALL BEST PRACTICES
// Replace 'your_database_name' with your actual database name
const mongoUri = process.env.MONGO_URI || "mongodb://mongo:rwcIrgaigtJDzbYLCqLrWgeAFTEauUGd@mongodb.railway.internal:27017/your_database_name?authSource=admin&directConnection=true&retryWrites=true";
console.log("MONGO_URI:", mongoUri); // VERY IMPORTANT: Keep this for debugging

mongoose.connect(mongoUri)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err);
        process.exit(1); // Exit the process if we can't connect to the database
    });

// Utility function to generate a short ID
function generateShortId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// 1. Create a new game
app.post('/api/games', async (req, res) => {
    try {
        const gameId = generateShortId(); // Or use uuidv4()
        const newGame = new Game({
            id: gameId,
            question: req.body.question,
            maxPredictors: 5, // Make it configurable if needed
            predictors: new Map(), // Initialize predictors
            predictions: new Map(), // Initialize predictions
        });
        await newGame.save();
        res.json({ gameId }); // Return the game ID
    } catch (error) {
        console.error("Error creating game:", error);
        res.status(500).json({ error: 'Failed to create game' });
    }
});

// 2. Join a game
app.post('/api/games/:gameId/join', async (req, res) => {
    const { gameId } = req.params;
    const { username } = req.body;

    try {
        const game = await Game.findOne({ id: gameId });
        if (!game) {
            return res.status(404).json({ error: 'Game not found' });
        }

        if (game.predictors.size >= game.maxPredictors) {
            return res.status(400).json({ error: 'Game is full' });
        }

        const predictorId = uuidv4();
        const predictorCount = game.predictors.size;

        game.predictors.set(predictorId, {
            id: predictorId,
            username,
            avatarColor: getAvatarColor(predictorCount),
            joinedAt: new Date(),
        });

        // IMPORTANT:  Use game.save() with Mongoose Maps!
        await game.save();

        // Send an update to all players in the room
        io.to(gameId).emit('predictor_update', {
            count: game.predictors.size,
            total: game.maxPredictors,
        });

        res.json({
            predictorId,
            game: {
                id: game.id,
                question: game.question,
                predictorCount: game.predictors.size,
                maxPredictors: game.maxPredictors,
            },
        });
    } catch (error) {
        console.error("Error joining game:", error);
        res.status(500).json({ error: 'Failed to join game' });
    }
});

// 3. Submit a prediction
app.post('/api/games/:gameId/predict', async (req, res) => {
    const { gameId } = req.params;
    const { predictorId, prediction } = req.body;

    try {
        const game = await Game.findOne({ id: gameId });
        if (!game) {
            return res.status(404).json({ error: 'Game not found' });
        }
        if (!game.predictors.has(predictorId)) {
            return res.status(403).json({ error: 'Not a valid predictor' });
        }

        if (game.predictions.size >= game.maxPredictors) {
            return res.status(400).json({ error: 'Predictions are full' });
        }

        game.predictions.set(predictorId, { content: prediction, submittedAt: new Date() });
         // IMPORTANT:  Use game.save() with Mongoose Maps!
        await game.save();


        const predictionsCount = game.predictions.size;
        const allPredictionsSubmitted = predictionsCount === game.maxPredictors;

        // Send an update to all players
        io.to(gameId).emit('prediction_update', { count: predictionsCount, total: game.maxPredictors });

        // If all predictions are submitted, reveal them
        if (allPredictionsSubmitted && !game.revealedToAll) {
            game.revealedToAll = true;
            // IMPORTANT:  Use game.save() with Mongoose Maps!
            await game.save();

            const predictionsArray = [];
            for (const [pid, predictionData] of game.predictions.entries()) {
                const predictor = game.predictors.get(pid);
                predictionsArray.push({
                    predictor,
                    prediction: predictionData
                });
            }

            io.to(gameId).emit('all_predictions_revealed', { predictions: predictionsArray });
        }

        res.json({ success: true, predictionsCount, allPredictionsSubmitted });
    } catch (error) {
        console.error("Error submitting prediction:", error);
        res.status(500).json({ error: 'Failed to submit prediction' });
    }
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('a user connected');

    socket.on('join_game', (gameId) => {
        socket.join(gameId); // Join the game room
        console.log(`User joined game: ${gameId}`);
    });

    socket.on('disconnect', () => {
        console.log('user disconnected');
        // Add code to handle player leaving
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Simple function to choose an avatar color
function getAvatarColor(index) {
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8'];
    return colors[index % colors.length];
}