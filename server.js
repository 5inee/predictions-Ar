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

app.use(express.static('public'));
app.use(express.json());

const mongoUri = process.env.MONGO_URI;
mongoose.connect(mongoUri)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

function generateShortId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

app.post('/api/games', async (req, res) => {
    try {
        const gameId = generateShortId();
        const newGame = new Game({
            id: gameId,
            question: req.body.question,
            maxPredictors: 5,
            predictors: new Map(),
            predictions: new Map(),
        });
        await newGame.save();
        res.json({ gameId });
    } catch (error) {
        console.error("Error creating game:", error);
        res.status(500).json({ error: 'Failed to create game' });
    }
});

app.post('/api/games/:gameId/join', async (req, res) => {
    const { gameId } = req.params;
    const { username } = req.body;

    try {
        const game = await Game.findOne({ id: gameId });
        if (!game) {
            return res.status(404).json({ error: 'Game not found' });
        }

        const predictorId = uuidv4();
        let isSpectator = false;

        if (game.predictors.size < game.maxPredictors) {
            game.predictors.set(predictorId, {
                id: predictorId,
                username,
                avatarColor: getAvatarColor(game.predictors.size),
                joinedAt: new Date(),
            });
            await game.save();

            io.to(gameId).emit('predictor_update', {
                count: game.predictors.size,
                total: game.maxPredictors,
            });
        } else {
            isSpectator = true;
        }

        let predictionsData = [];
        if (game.revealedToAll) {
            for (const [pid, predictionData] of game.predictions.entries()) {
                const predictor = game.predictors.get(pid);
                predictionsData.push({
                    predictor,
                    prediction: predictionData
                });
            }
        }

        res.json({
            predictorId,
            isSpectator,
            game: {
                id: game.id,
                question: game.question,
                predictorCount: game.predictors.size,
                maxPredictors: game.maxPredictors,
                allPredictionsRevealed: game.revealedToAll,
                predictions: predictionsData,
            },
        });

    } catch (error) {
        console.error("Error joining game:", error);
        res.status(500).json({ error: 'Failed to join game' });
    }
});

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

        if (!game.predictions || game.predictions.size >= game.maxPredictors) {
            return res.status(400).json({ error: 'Predictions are full' });
        }

        game.predictions.set(predictorId, { content: prediction, submittedAt: new Date() });
        await game.save();

        const predictionsCount = game.predictions.size;
        const allPredictionsSubmitted = predictionsCount === game.maxPredictors;

        io.to(gameId).emit('prediction_update', { count: predictionsCount, total: game.maxPredictors });

        if (allPredictionsSubmitted && !game.revealedToAll) {
            game.revealedToAll = true;
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
    console.log('a user connected with socket ID:', socket.id);
    let joinedGameId = null;
    //  لم يعد هناك حاجة لـ currentPredictorId هنا

    socket.on('join_game', async (gameId, predictorId) => { // استقبال predictorId
        socket.join(gameId);
        joinedGameId = gameId;
        console.log(`User joined game: ${gameId}, predictorId: ${predictorId}`);

        //  لا حاجة للبحث عن predictorId هنا -  لقد استقبلناه
    });

    socket.on('disconnect', async () => {
        console.log(`user disconnected with socket ID: ${socket.id}`);

        if (joinedGameId) { // فقط تحقق من gameId
            try {
                const game = await Game.findOne({ id: joinedGameId });
                if (game) {
                    //  ابحث عن اللاعب بناءً على socket.id
                    let predictorIdToDelete = null;
                    for (const [key, value] of game.predictors.entries()) {
                        //  مقارنة بمعرف الاتصال
                        if (value.id === socket.handshake.query.predictorId) {
                            predictorIdToDelete = key;
                            break;
                        }
                    }


                    if (predictorIdToDelete && !game.predictions.has(predictorIdToDelete)) {
                        game.predictors.delete(predictorIdToDelete);
                        await game.save();
                        io.to(joinedGameId).emit('predictor_update', {
                            count: game.predictors.size,
                            total: game.maxPredictors,
                        });
                    }
                }
            } catch (error) {
                console.error("Error handling disconnect:", error);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

function getAvatarColor(index) {
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8'];
    return colors[index % colors.length];
}