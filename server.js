require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Game = require('./models/Game'); // استيراد الموديل

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static('public'));
app.use(express.json()); // عشان نقدر نقرأ بيانات JSON من الطلبات

// MongoDB connection
const mongoUri = process.env.MONGO_URI;
mongoose.connect(mongoUri)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// دالة لتوليد ID قصير (ممكن تستخدمها أو uuid)
function generateShortId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// 1.  إنشاء لعبة جديدة (Create a new game)
app.post('/api/games', async (req, res) => {
    try {
        const gameId = generateShortId(); // أو استخدم uuidv4()
        const newGame = new Game({
            id: gameId,
            question: req.body.question,
            maxPredictors: 5, // ممكن تخليه متغير
            predictors: new Map(), // تهيئة predictors
            predictions: new Map(), // تهيئة predictions هنا
        });
        await newGame.save();
        res.json({ gameId }); // نرجع ID اللعبة
    } catch (error) {
        console.error("Error creating game:", error);
        res.status(500).json({ error: 'Failed to create game' });
    }
});

// 2. الانضمام إلى لعبة (Join a game)
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

        //  تم التعديل هنا:  شيل الشرط الخاص بامتلاء اللعبة.
        if (game.predictors.size < game.maxPredictors) {
            // Player is a predictor
            game.predictors.set(predictorId, {
                id: predictorId,
                username,
                avatarColor: getAvatarColor(game.predictors.size),
                joinedAt: new Date(),
            });
            await game.save();

             // إرسال تحديث لكل اللاعبين في الغرفة
             io.to(gameId).emit('predictor_update', {
                count: game.predictors.size,
                total: game.maxPredictors,
            });
        } else {
            // Player is a spectator
            isSpectator = true;
        }
        let predictionsData = []
        if (game.revealedToAll) {
           // Iterate through each prediction
            for (const [pid, predictionData] of game.predictions.entries()) {
              // Get the predictor information
              const predictor = game.predictors.get(pid);

              // Add to the array with the right structure
              predictionsData.push({
                  predictor,
                  prediction: predictionData
              });
            }
        }


        res.json({
            predictorId,
            isSpectator, // إضافة معلومة هل اللاعب مشاهد
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

// 3. إرسال توقع (Submit a prediction)
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

        //  تم التعديل هنا: استخدام الطريقة الثانية (فحص undefined) كبديل أسهل.
        if (!game.predictions || game.predictions.size >= game.maxPredictors) {
            return res.status(400).json({ error: 'Predictions are full' });
        }

        game.predictions.set(predictorId, { content: prediction, submittedAt: new Date() });
        await game.save();

        const predictionsCount = game.predictions.size;
        const allPredictionsSubmitted = predictionsCount === game.maxPredictors;

        // إرسال تحديث لجميع اللاعبين في الغرفة بعدد التوقعات
        io.to(gameId).emit('prediction_update', { count: predictionsCount, total: game.maxPredictors });

        // إذا اكتمل عدد التوقعات، أرسل كل التوقعات
        if (allPredictionsSubmitted && !game.revealedToAll) {
            game.revealedToAll = true;
            await game.save();

            const predictionsArray = [];

            // Iterate through each prediction
            for (const [pid, predictionData] of game.predictions.entries()) {
                // Get the predictor information
                const predictor = game.predictors.get(pid);

                // Add to the array with the right structure
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
    let currentPredictorId = null;

    socket.on('join_game', async (gameId) => {
        socket.join(gameId); // ضم اللاعب إلى غرفة اللعبة
        joinedGameId = gameId;
        console.log(`User joined game: ${gameId}`);

        // Find the game and add socket id
        try {
            const game = await Game.findOne({ id: gameId });
            if (game) {
                // Find Predictor Id  -  التعديل هنا!
                for (let [key, value] of game.predictors.entries()) {
                    if (value.id === socket.handshake.query.predictorId) { // قارن بمعرف اللاعب
                        currentPredictorId = key;
                        break; // اخرج من الحلقة بعد العثور على اللاعب
                    }
                }
            }

        } catch (error) {
            console.error("Error finding game on join_game:", error);
        }

    });

    socket.on('disconnect', async () => {
        console.log(`user disconnected with socket ID: ${socket.id}`);

        if (joinedGameId && currentPredictorId) {
            try {
                const game = await Game.findOne({ id: joinedGameId });

                if (game && game.predictors.has(currentPredictorId)) {
                    // Check if prediction has been submitted
                    if (!game.predictions.has(currentPredictorId)) {
                        // Player disconnected BEFORE submitting, remove
                        game.predictors.delete(currentPredictorId);
                        await game.save();

                         // إرسال تحديث لكل اللاعبين في الغرفة
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

// دالة بسيطة لاختيار لون للصورة الرمزية
function getAvatarColor(index) {
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8'];
    return colors[index % colors.length];
}