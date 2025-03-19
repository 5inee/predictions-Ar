document.addEventListener('DOMContentLoaded', () => {
    const socket = io({
        query: {
            // سيتم ملء هذا لاحقا
        }
      });

    // DOM Elements
    const joinScreen = document.getElementById('joinScreen');
    const createGameScreen = document.getElementById('createGameScreen');
    const gameScreen = document.getElementById('gameScreen');
    const gameIdInput = document.getElementById('gameId');
    const usernameInput = document.getElementById('username');
    const joinGameBtn = document.getElementById('joinGameBtn');
    const createGameBtn = document.getElementById('createGameBtn');
    const gameQuestionInput = document.getElementById('gameQuestion');
    const secretCodeInput = document.getElementById('secretCode');
    const secretCodeError = document.getElementById('secretCodeError');
    const createNewGameBtn = document.getElementById('createNewGameBtn');
    const backToJoinBtn = document.getElementById('backToJoinBtn');
    const gameQuestionDisplay = document.querySelector('#gameScreen .game-title');
    const gameCodeDisplay = document.getElementById('gameCodeDisplay');
    const copyButton = document.querySelector('.copy-button');
    const waitingMessage = document.getElementById('waitingMessage');
    const playerCountDisplay = document.querySelector('.player-count');
    const predictionForm = document.getElementById('predictionForm');
    const predictionInput = document.getElementById('prediction');
    const submitPredictionBtn = document.getElementById('submitPredictionBtn');
    const pastePredictionBtn = document.getElementById('pastePredictionBtn');
    const clearPredictionBtn = document.getElementById('clearPredictionBtn');
    const statusMessage = document.getElementById('statusMessage');
    const predictionCount = document.getElementById('predictionCount');
    const predictionsList = document.getElementById('predictionsList');
    const predictionsContainer = document.getElementById('predictionsContainer');
    const counterText = document.querySelector('.counter-text');

    // App State
    let currentGameId = null;
    let currentPredictorId = null;
    let hasSubmitted = false;
    let currentUsername = '';

    // Secret code constant
    const CORRECT_SECRET_CODE = '021';

    // Show initial screen
    joinScreen.style.display = 'block';

    // Helper Functions
    function showToast(message, isSuccess = false) {
        const backgroundColor = isSuccess
            ? "linear-gradient(to right, #06d6a0, #06b88a)"
            : "linear-gradient(to right, #ef476f, #d93d63)";

        Toastify({
            text: message,
            duration: 3000,
            newWindow: true,
            close: true,
            gravity: "top",
            position: "center", // Toast position remains LTR, even in RTL layout
            stopOnFocus: true,
            style: {
                background: backgroundColor,
                borderRadius: "12px",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
                padding: "12px 20px",
            },
        }).showToast();
    }

    function showScreen(screenId) {
        // Hide all screens
        joinScreen.style.display = 'none';
        createGameScreen.style.display = 'none';
        gameScreen.style.display = 'none';

        // Show the requested screen
        document.getElementById(screenId).style.display = 'block';

        // Additional setup for specific screens

    }

    function generateRandomColor() {
        const colors = [
            '#5e60ce', '#6a67ce', '#7678ed', '#3d4fd1', '#5151d4',
            '#64dfdf', '#56c2c2', '#72efef', '#118ab2', '#06d6a0'
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    function formatTime(dateString) {
        const date = new Date(dateString);
        return date.toLocaleTimeString('ar-EG', { // Use Arabic locale for time formatting
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
    }


    function resetGameState() {
        predictionForm.style.display = 'block';
        waitingMessage.style.display = 'block';
        statusMessage.style.display = 'none';
        predictionCount.style.display = 'none';
        predictionsList.style.display = 'none';
        predictionInput.value = '';
        predictionInput.removeAttribute('readonly');
        hasSubmitted = false;
        predictionsContainer.innerHTML = '';
    }

    // Event Listeners
    createGameBtn.addEventListener('click', () => {
        showScreen('createGameScreen');
        secretCodeError.style.display = 'none';
    });

    backToJoinBtn.addEventListener('click', () => {
        showScreen('joinScreen');
    });

    createNewGameBtn.addEventListener('click', async () => {
        const question = gameQuestionInput.value.trim();
        const secretCode = secretCodeInput.value.trim();

        if (!question) {
            showToast('الرجاء إدخال سؤال التحدي.');
            gameQuestionInput.focus();
            return;
        }

        if (secretCode !== CORRECT_SECRET_CODE) {
            showToast('رمز سري غير صالح.');
            secretCodeError.style.display = 'block';
            secretCodeInput.classList.add('shake');

            setTimeout(() => {
                secretCodeInput.classList.remove('shake');
            }, 500);
            return;
        }

        try {
            const response = await fetch('/api/games', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'فشل في إنشاء اللعبة');
            }

            const data = await response.json();

            // Auto-fill the game ID in the join screen
            gameIdInput.value = data.gameId;
            showScreen('joinScreen');
            gameIdInput.classList.add('highlight');

            setTimeout(() => {
                gameIdInput.classList.remove('highlight');
            }, 1500);

            showToast(`تم إنشاء اللعبة! كود اللعبة: ${data.gameId}`, true);
            secretCodeInput.value = '';
            gameQuestionInput.value = '';
        } catch (error) {
            console.error('Error creating game:', error);
            showToast('فشل في إنشاء اللعبة.  الرجاء المحاولة مرة أخرى.');
        }
    });

    joinGameBtn.addEventListener('click', async () => {
        const gameId = gameIdInput.value.trim().toUpperCase();
        const username = usernameInput.value.trim();

        if (!gameId) {
            showToast('الرجاء إدخال كود اللعبة.');
            gameIdInput.focus();
            return;
        }

        if (!username) {
            showToast('الرجاء إدخال اسمك.');
            usernameInput.focus();
            return;
        }

        try {
            const response = await fetch(`/api/games/${gameId}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'فشل في الانضمام إلى اللعبة');
            }

            const data = await response.json();

            currentGameId = data.game.id;
            currentPredictorId = data.predictorId; // تخزين ال predictorId
            currentUsername = username;

            showScreen('gameScreen');
            resetGameState();

            // Update UI with game info
            gameQuestionDisplay.textContent = data.game.question;
            gameCodeDisplay.textContent = data.game.id;

            // Set initial player count
            playerCountDisplay.textContent = `اللاعبون: ${data.game.predictorCount}/${data.game.maxPredictors}`;

            // Join the socket room --  التعديل هنا!
            socket.io.opts.query = { predictorId: currentPredictorId }; // اضف ال predictorId
            socket.emit('join_game', currentGameId);

           // Handle spectator/predictor
           if (data.isSpectator || data.game.allPredictionsRevealed) {
                // Hide prediction form, show predictions directly

                waitingMessage.style.display = 'none';
                predictionForm.style.display = 'none';
                statusMessage.style.display = 'none';
                predictionCount.style.display = 'none';
                predictionsContainer.innerHTML = '';

                 data.game.predictions.forEach((item) => {
                    const { predictor, prediction } = item;
                    const isCurrentUser = predictor.id === currentPredictorId;
                    const avatarColor = predictor.avatarColor || generateRandomColor();

                    const predictionCard = document.createElement('div');
                    predictionCard.className = `prediction-card ${isCurrentUser ? 'fade-in' : ''}`;

                    const formattedPrediction = prediction.content.replace(/\n/g, '<br>');

                        predictionCard.innerHTML = `
                        <div class="prediction-header">
                            <div class="predictor-info">
                                <div class="predictor-avatar" style="background-color: ${avatarColor}">
                                    ${predictor.username.charAt(0).toUpperCase()}
                                </div>
                                <div class="predictor-name">
                                    ${predictor.username} ${isCurrentUser ? '(أنت)' : ''}
                                </div>
                            </div>
                            <div class="timestamp">${formatTime(prediction.submittedAt)}</div>
                        </div>
                        <div class="prediction-content">${formattedPrediction}</div>
                    `;

                    predictionsContainer.appendChild(predictionCard);
                });
                predictionsList.style.display = 'block';
                predictionsList.scrollIntoView({ behavior: 'smooth' });
           }


            showToast(`مرحبًا بك في اللعبة، ${username}!`, true);
        } catch (error) {
            console.error('Error joining game:', error);
            showToast(error.message || 'فشل في الانضمام إلى اللعبة.  الرجاء المحاولة مرة أخرى.');
        }
    });

    copyButton.addEventListener('click', () => {
        if (!currentGameId) return;

        navigator.clipboard.writeText(currentGameId)
            .then(() => {
                showToast('تم نسخ كود اللعبة إلى الحافظة!', true);
            })
            .catch(err => {
                console.error('Failed to copy game code:', err);
                showToast('فشل في نسخ كود اللعبة.');
            });
    });

    pastePredictionBtn.addEventListener('click', async () => {
        if (hasSubmitted) return;

        try {
            const text = await navigator.clipboard.readText();
            predictionInput.value = text;
            predictionInput.focus();
        } catch (err) {
            console.error('Failed to read clipboard:', err);
            showToast('فشل اللصق.  الرجاء التحقق من أذونات الحافظة.');
        }
    });

    clearPredictionBtn.addEventListener('click', () => {
        if (hasSubmitted) return;
        predictionInput.value = '';
        predictionInput.focus();
    });

    submitPredictionBtn.addEventListener('click', async () => {
        const prediction = predictionInput.value.trim();

        if (!prediction) {
            showToast("الرجاء إدخال توقعك أو لصقه.");
            predictionInput.focus();
            return;
        }

        if (hasSubmitted) {
            showToast('لقد أرسلت توقعًا بالفعل.');
            return;
        }

        try {
            const response = await fetch(`/api/games/${currentGameId}/predict`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    predictorId: currentPredictorId,
                    prediction
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'فشل في إرسال التوقع');
            }

            const data = await response.json();

            hasSubmitted = true;
            predictionInput.setAttribute('readonly', true);

            // Update UI based on submission status
            predictionForm.style.display = 'none';
            statusMessage.style.display = 'block';
            predictionCount.style.display = 'block';

            if (data.allPredictionsSubmitted) {
                statusMessage.innerHTML = '<i class="fas fa-check-circle"></i><span> تم إرسال كافة التوقعات، يمكنك الاطلاع عليها أدناه.</span>';
            } else {
                statusMessage.innerHTML = '<i class="fas fa-check-circle"></i><span> تم إرسال توقعك. في انتظار انتهاء الآخرين...</span>';
            }

            showToast('تم إرسال التوقع بنجاح!', true);
        } catch (error) {
            console.error('Error submitting prediction:', error);
            showToast(error.message || 'فشل في إرسال التوقع.  الرجاء المحاولة مرة أخرى.');
        }
    });

    // Socket.IO Event Handlers
    socket.on('connect', () => {
        console.log('Connected to server');
    });

    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showToast('خطأ في الاتصال.  الرجاء تحديث الصفحة.');
    });

    socket.on('predictor_update', (data) => {
        console.log('Received predictor_update:', data);
        playerCountDisplay.textContent = `اللاعبون: ${data.count}/${data.total}`;

        if (data.count === data.total) {
            waitingMessage.style.display = 'none';
        } else {
            waitingMessage.style.display = 'block';
        }
    });

    socket.on('prediction_update', (data) => {
        console.log('Received prediction_update:', data);
        if (predictionCount) {
            predictionCount.style.display = 'block';
            document.querySelector('.counter-text').textContent = `التوقعات: ${data.count}/${data.total}`;

            if (data.count === data.total && hasSubmitted) {
                // All predictions are in
                statusMessage.innerHTML = '<i class="fas fa-check-circle"></i><span>تم إرسال جميع التوقعات! سيتم الكشف عن النتائج قريبًا...</span>';
            }
        }
    });

    socket.on('all_predictions_revealed', (data) => {
        console.log('Received all_predictions_revealed:', data);

        // Update UI for results view
        waitingMessage.style.display = 'none';
        statusMessage.style.display = 'none';
        predictionCount.style.display = 'none';
        predictionForm.style.display = 'none';
        predictionsContainer.innerHTML = '';

        // Generate prediction cards
        data.predictions.forEach((item) => {
            const { predictor, prediction } = item;
            const isCurrentUser = predictor.id === currentPredictorId;
            const avatarColor = predictor.avatarColor || generateRandomColor();

            const predictionCard = document.createElement('div');
            predictionCard.className = `prediction-card ${isCurrentUser ? 'fade-in' : ''}`;

            const formattedPrediction = prediction.content.replace(/\n/g, '<br>');

             predictionCard.innerHTML = `
                <div class="prediction-header">
                    <div class="predictor-info">
                        <div class="predictor-avatar" style="background-color: ${avatarColor}">
                            ${predictor.username.charAt(0).toUpperCase()}
                        </div>
                        <div class="predictor-name">
                            ${predictor.username} ${isCurrentUser ? '(أنت)' : ''}
                        </div>
                    </div>
                    <div class="timestamp">${formatTime(prediction.submittedAt)}</div>
                </div>
                <div class="prediction-content">${formattedPrediction}</div>
            `;

            predictionsContainer.appendChild(predictionCard);
        });

        predictionsList.style.display = 'block';

        // Scroll to predictions section
        predictionsList.scrollIntoView({ behavior: 'smooth' });

    });

    socket.on('game_error', (error) => {
        showToast(error.message || 'حدث خطأ في اللعبة');
    });

    // Handle enter key in input fields
    gameIdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            usernameInput.focus();
        }
    });

    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinGameBtn.click();
        }
    });

    gameQuestionInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            secretCodeInput.focus();
        }
    });

    secretCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            createNewGameBtn.click();
        }
    });
});