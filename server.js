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
                // التحقق مما إذا كان اللاعب غير نشط (مر وقت طويل على انضمامه ولم يرسل توقعًا)
                if (!game.predictions.has(predictorId)) {
                    game.predictors.delete(predictorId);
                    console.log(`Predictor ${predictorId} removed from game ${game.id} due to inactivity.`);
                    predictorsChanged = true;
                }
            }

            if (predictorsChanged) {
                await game.save();
                
                // حساب عدد اللاعبين النشطين بعد الحذف
                let activePredictorCount = 0;
                for (const [, predictor] of game.predictors.entries()) {
                    if (!predictor.viewOnly) {
                        activePredictorCount++;
                    }
                }
                
                // إرسال تحديث لجميع اللاعبين في الغرفة
                io.to(game.id).emit('predictor_update', {
                    count: Math.min(activePredictorCount, game.maxPredictors),
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

        // نتحقق إذا كانت اللعبة ممتلئة وإذا كانت جميع التوقعات قد أرسلت
        const isGameFull = (game.predictors?.size || 0) >= game.maxPredictors;
        const allPredictionsSubmitted = game.predictions.size >= game.maxPredictors;

        // لو اللعبة ممتلئة لكن التوقعات لم تكتمل بعد، نرفض الانضمام
        if (isGameFull && !allPredictionsSubmitted) {
            return res.status(400).json({ error: 'Game is full' });
        }

        const predictorId = uuidv4();
        const predictorCount = game.predictors.size;

        // إضافة علامة viewOnly للاعبين الإضافيين بعد اكتمال العدد
        const isViewOnly = isGameFull && allPredictionsSubmitted;

        game.predictors.set(predictorId, {
            id: predictorId,
            username,
            avatarColor: getAvatarColor(predictorCount),
            joinedAt: new Date(),
            viewOnly: isViewOnly // إضافة صفة viewOnly
        });

        await game.save();

        // حساب عدد اللاعبين النشطين فقط (استبعاد من هم في وضع المشاهدة)
        let activePredictorCount = 0;
        for (const [, predictor] of game.predictors.entries()) {
            if (!predictor.viewOnly) {
                activePredictorCount++;
            }
        }

        // إرسال عدد اللاعبين النشطين فقط
        io.to(gameId).emit('predictor_update', {
            count: Math.min(activePredictorCount, game.maxPredictors),
            total: game.maxPredictors,
        });

        res.json({
            predictorId,
            game: {
                id: game.id,
                question: game.question,
                predictorCount: activePredictorCount, // تحديث هنا أيضًا
                maxPredictors: game.maxPredictors,
                isViewOnly: isViewOnly,
                allPredictionsSubmitted: allPredictionsSubmitted
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

        // التحقق من أن اللاعب ليس في وضع المشاهدة فقط
        const predictor = game.predictors.get(predictorId);
        if (predictor.viewOnly) {
            return res.status(403).json({ error: 'View-only players cannot submit predictions' });
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

    // إضافة معالج لطلب التوقعات
    socket.on('request_predictions', async (gameId) => {
        try {
            const game = await Game.findOne({ id: gameId });
            if (!game || !game.revealedToAll) return;

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

            // إرسال التوقعات للمستخدم الذي طلبها فقط
            socket.emit('all_predictions_revealed', { predictions: predictionsArray });
        } catch (error) {
            console.error("Error fetching predictions:", error);
            socket.emit('game_error', { message: 'فشل في تحميل التوقعات' });
        }
    });

    socket.on('disconnect', async () => {
        console.log('user disconnected');

        //  إزالة اللاعب من اللعبة إذا لم يكن قد أرسل توقع
        try {
            const games = await Game.find({});
            for (const game of games) {
                let predictorRemoved = false;
                for (const [predictorId, predictorData] of game.predictors.entries()) {
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
                    
                    // حساب عدد اللاعبين النشطين بعد الحذف
                    let activePredictorCount = 0;
                    for (const [, predictor] of game.predictors.entries()) {
                        if (!predictor.viewOnly) {
                            activePredictorCount++;
                        }
                    }
                    
                    io.to(game.id).emit('predictor_update', {
                        count: Math.min(activePredictorCount, game.maxPredictors),
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