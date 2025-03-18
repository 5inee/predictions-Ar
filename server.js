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

app.use(express.static('public'));
app.use(express.json()); // دعم JSON في الطلبات

// ✅ 1. التحقق من تحميل MONGO_URI من env
const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
    console.error('❌ MONGO_URI is not defined! Check your .env file.');
    process.exit(1);
}

// ✅ 2. تحسين الاتصال بقاعدة البيانات مع إعادة المحاولة
const connectWithRetry = () => {
    console.log('🔄 Attempting MongoDB connection...');
    mongoose.connect(mongoUri, { 
        useNewUrlParser: true, 
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000 // مهلة للاتصال
    })
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err);
        setTimeout(connectWithRetry, 5000); // إعادة المحاولة بعد 5 ثواني
    });
};
connectWithRetry();

// ✅ 3. وظيفة لتوليد ID قصير
function generateShortId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// ✅ 4. إنشاء لعبة جديدة
app.post('/api/games', async (req, res) => {
    try {
        const gameId = generateShortId();
        const newGame = new Game({
            id: gameId,
            question: req.body.question,
            maxPredictors: 5,
            predictors: new Map(),
            predictions: new Map(),
            revealedToAll: false
        });

        await newGame.save();
        res.json({ gameId });
    } catch (error) {
        console.error("❌ Error creating game:", error);
        res.status(500).json({ error: 'Failed to create game' });
    }
});

// ✅ 5. الانضمام إلى لعبة
app.post('/api/games/:gameId/join', async (req, res) => {
    const { gameId } = req.params;
    const { username } = req.body;

    try {
        const game = await Game.findOne({ id: gameId });
        if (!game) return res.status(404).json({ error: 'Game not found' });

        if ((game.predictors?.size || 0) >= game.maxPredictors) {
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

        await game.save();
        io.to(gameId).emit('predictor_update', { count: game.predictors.size, total: game.maxPredictors });

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
        console.error("❌ Error joining game:", error);
        res.status(500).json({ error: 'Failed to join game' });
    }
});

// ✅ 6. إرسال توقع
app.post('/api/games/:gameId/predict', async (req, res) => {
    const { gameId } = req.params;
    const { predictorId, prediction } = req.body;

    try {
        const game = await Game.findOne({ id: gameId });
        if (!game) return res.status(404).json({ error: 'Game not found' });

        if (!game.predictors.has(predictorId)) {
            return res.status(403).json({ error: 'Not a valid predictor' });
        }

        if (!game.predictions) game.predictions = new Map();
        if (game.predictions.size >= game.maxPredictors) {
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
                predictionsArray.push({ predictor, prediction: predictionData });
            }

            io.to(gameId).emit('all_predictions_revealed', { predictions: predictionsArray });
        }

        res.json({ success: true, predictionsCount, allPredictionsSubmitted });
    } catch (error) {
        console.error("❌ Error submitting prediction:", error);
        res.status(500).json({ error: 'Failed to submit prediction' });
    }
});

// ✅ 7. إعداد WebSockets
io.on('connection', (socket) => {
    console.log('🔗 A user connected');

    socket.on('join_game', (gameId) => {
        socket.join(gameId);
        console.log(`👥 User joined game: ${gameId}`);
    });

    socket.on('disconnect', () => {
        console.log('❌ User disconnected');
    });
});

// ✅ 8. تشغيل السيرفر
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

// ✅ 9. دالة اختيار لون للصورة الرمزية
function getAvatarColor(index) {
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8'];
    return colors[index % colors.length];
}
