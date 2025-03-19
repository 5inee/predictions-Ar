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

const INACTIVE_TIMEOUT = 2 * 60 * 1000; // 2 minutes in milliseconds

// دالة للتحقق من اللاعبين غير النشطين وحذفهم
async function checkInactivePredictors() {
    try {
        // استعلام مُحسّن لجلب الألعاب التي بها لاعبين غير نشطين فقط
        const cutoffTime = new Date(Date.now() - INACTIVE_TIMEOUT);
        const games = await Game.find({
            'predictors': {
                $elemMatch: {
                    'joinedAt': { $lt: cutoffTime }
                }
            }
        });


        for (const game of games) {
            let predictorsChanged = false;

            for (const [predictorId, predictorData] of game.predictors.entries()) {
                //  لا حاجة لحساب timeSinceJoin هنا، الاستعلام يضمن أن joinedAt < cutoffTime

                // التحقق مما إذا كان اللاعب غير نشط (مر وقت طويل على انضمامه ولم يرسل توقعًا)
                if (!game.predictions.has(predictorId)) {
                    game.predictors.delete(predictorId);
                    console.log(`Predictor ${predictorId} removed from game ${game.id} due to inactivity.`);
                    predictorsChanged = true;
                }
            }

            if (predictorsChanged) {
                await game.save();
                // إرسال تحديث لجميع اللاعبين في الغرفة
                io.to(game.id).emit('predictor_update', {
                    count: game.predictors.size,
                    total: game.maxPredictors,
                });
            }
        }
    } catch (error) {
        console.error("Error checking inactive predictors:", error);
    }
}

// تشغيل دالة التحقق بشكل دوري (كل دقيقة)
setInterval(checkInactivePredictors, 60 * 1000);  // Check every minute


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

        const isSpectator = (game.predictors?.size || 0) >= game.maxPredictors;

if (!isSpectator) {
    const predictorId = uuidv4();
    const predictorCount = game.predictors.size;

    game.predictors.set(predictorId, {
        id: predictorId,
        username,
        avatarColor: getAvatarColor(predictorCount),
        joinedAt: new Date(),
    });

    await game.save();

    io.to(gameId).emit('predictor_update', {
        count: game.predictors.size,
        total: game.maxPredictors,
    });

    return res.json({
        predictorId,
        game: {
            id: game.id,
            question: game.question,
            predictorCount: game.predictors.size,
            maxPredictors: game.maxPredictors,
        },
    });
}

// اللاعب السادس وما بعده سيكون متفرجًا فقط
return res.json({
    spectator: true,
    game: {
        id: game.id,
        question: game.question,
        predictions: Array.from(game.predictions.values()), // إرسال التوقعات مباشرة
        predictorCount: game.predictors.size,
        maxPredictors: game.maxPredictors,
    }
});


        const predictorId = uuidv4();
        const predictorCount = game.predictors.size;

        game.predictors.set(predictorId, {
            id: predictorId,
            username,
            avatarColor: getAvatarColor(predictorCount),
            joinedAt: new Date(), // إضافة وقت الانضمام هنا
        });

        await game.save();

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
    console.log('a user connected');

    socket.on('join_game', (gameId) => {
        socket.join(gameId);
        console.log(`User joined game: ${gameId}`);
    });

    socket.on('disconnect', async () => {
        console.log('user disconnected');

        //  إزالة اللاعب من اللعبة إذا لم يكن قد أرسل توقع
        try {
            const games = await Game.find({});
            for (const game of games) {
              let predictorRemoved = false;
              for (const [predictorId, predictorData] of game.predictors.entries())
              {
                //لا يمكن مطابقة id, لذلك قمت بتعليق هذا الجزء
                // if (predictorData.id === socket.id) {
                    // Remove if no prediction submitted
                  if (!game.predictions.has(predictorId)) {
                    game.predictors.delete(predictorId);
                    console.log(`Predictor ${predictorId} removed from game ${game.id} on disconnect.`);
                    predictorRemoved = true;
                }
                // }
            }
              if(predictorRemoved){
                await game.save();
                io.to(game.id).emit('predictor_update', {
                        count: game.predictors.size,
                        total: game.maxPredictors
                    });
              }
            }

        } catch (error) {
            console.error("Error handling disconnect:", error);
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