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

        // هنا التعديل:  نتأكد أن game.predictors موجود قبل ما نستخدم Object.keys()
        if ((game.predictors?.size || 0) >= game.maxPredictors) {
            return res.status(400).json({ error: 'Game is full' });
        }

        const predictorId = uuidv4();
        const predictorCount = game.predictors.size; //  استخدام .size

        game.predictors.set(predictorId, {
            id: predictorId,
            username,
            avatarColor: getAvatarColor(predictorCount),
            joinedAt: new Date(),
        });

        await game.save();

        // إرسال تحديث لكل اللاعبين في الغرفة
        io.to(gameId).emit('predictor_update', {
            count: game.predictors.size, //  .size
            total: game.maxPredictors,
        });

        res.json({
            predictorId,
            game: {
                id: game.id,
                question: game.question,
                predictorCount: game.predictors.size, //  .size
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
const connectedPlayers = new Map(); // Map to track connected players (predictorId -> socketId)

io.on('connection', (socket) => {
    console.log('a user connected');

    socket.on('join_game', (data) => { //  تعديل: استقبل بيانات اللاعب مع الحدث
        const { gameId, predictorId } = data;
        socket.join(gameId);
        console.log(`User ${predictorId} joined game: ${gameId}`);

        // Store the connection
        connectedPlayers.set(predictorId, socket.id);

        //  إضافة:  إرسال حدث تأكيد الانضمام مع بيانات اللاعب
        socket.emit('join_confirmed', { predictorId });
    });


    socket.on('disconnect', async () => {  //  تعديل:  اجعلها async
        console.log('user disconnected');

        // Find the predictorId associated with this socket
        let disconnectedPredictorId = null;
        for (const [predictorId, socketId] of connectedPlayers.entries()) {
            if (socketId === socket.id) {
                disconnectedPredictorId = predictorId;
                break;
            }
        }

        if (disconnectedPredictorId) {
            connectedPlayers.delete(disconnectedPredictorId);  // Remove from connected players

            //  تعديل: استخدم  Promise.all  للتأكد من أن كلا العمليتين تتم بشكل صحيح
            try {
                await Promise.all([
                    removePlayerIfNotPredicted(disconnectedPredictorId) // Remove if no prediction
                ]);
            } catch (error) {
              console.error("Error handling disconnect:", error)
            }


        }
    });
});

async function removePlayerIfNotPredicted(predictorId) {
    try {
        const game = await Game.findOne({ 'predictors': { $elemMatch: { id: predictorId } } });  //  تعديل:  ابحث عن اللعبة اللي فيها اللاعب ده
        if (!game) {
            console.log(`Game not found for predictor: ${predictorId}`);
            return;
        }
      // Check if they have an associated prediction:
        if (!game.predictions.has(predictorId)) {
            // No prediction, remove the predictor
            game.predictors.delete(predictorId);  // Delete using the predictorId

             // Check if predictions Map exists before accessing its size
            if (game.predictions && game.predictions.size > 0) {
               io.to(game.id).emit('prediction_update', { count: game.predictions.size, total: game.maxPredictors });
            }

            await game.save();
            console.log(`Predictor ${predictorId} removed from game ${game.id}`);


            io.to(game.id).emit('predictor_update', { count: game.predictors.size, total: game.maxPredictors });

        } else {
             console.log(`Predictor ${predictorId} has a prediction, not removing.`);
        }
    } catch (error) {
        console.error("Error in removePlayerIfNotPredicted:", error);
    }
}



const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// دالة بسيطة لاختيار لون للصورة الرمزية
function getAvatarColor(index) {
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8'];
    return colors[index % colors.length];
}