const video = document.getElementById('camera-view');
const canvas = document.getElementById('canvas-output');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('start-btn');
const stopRecordBtn = document.getElementById('stop-record-btn');
const statusText = document.getElementById('status');

let src = null, dst = null, hsv = null, mask = null, contours = null, hierarchy = null;
let isProcessing = false;

// lockCounterは「安定判定が成功した連続フレーム数」として活用
let lockCounter = 0;
const REQUIRED_FRAMES = 150; // 合計5秒間（150フレーム分）安定を維持

// ブレ対策：直近30フレームの履歴を記憶するバッファ（打率制）
const BUFFER_SIZE = 30;
let detectionHistory = new Array(BUFFER_SIZE).fill(false);
let historyIndex = 0;

let mediaRecorder;
let isRecording = false;
let cameraStream = null;
let animationFrameId = null;

// --- IndexedDB の初期化設定 ---
const DB_NAME = "ExperimentVideoDB";
const STORE_NAME = "video_chunks";
let db = null;

function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { autoIncrement: true });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve();
        };
        request.onerror = (e) => {
            reject(e.target.error);
        };
    });
}

function clearDatabase() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function saveChunkToDB(chunk) {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.add(chunk);
}

function getAllChunksFromDB() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// OpenCVオブジェクトの一括安全解放関数 (メモリリーク対策)
function deleteAllMats() {
    if (src) { src.delete(); src = null; }
    if (dst) { dst.delete(); dst = null; }
    if (hsv) { hsv.delete(); hsv = null; }
    if (mask) { mask.delete(); mask = null; }
    if (contours) { contours.delete(); contours = null; }
    if (hierarchy) { hierarchy.delete(); hierarchy = null; }
}

document.getElementById('opencv-src').addEventListener('load', async () => {
    try {
        await initIndexedDB();
        statusText.innerText = "準備完了！ボタンを押してスキャンを開始してください";
        startBtn.disabled = false;
    } catch (err) {
        statusText.innerText = "データベース初期化失敗: " + err.message;
    }
});

startBtn.addEventListener('click', async () => {
    statusText.innerText = "広角スキャン用カメラを探索中...";
    try {
        await clearDatabase();

        const initStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        initStream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');

        let targetDeviceId = null;
        const wideDevice = videoDevices.find(d => {
            const label = d.label.toLowerCase();
            return label.includes('ultra') || label.includes('wide') || label.includes('0.5') || label.includes('超広角');
        });

        if (wideDevice) targetDeviceId = wideDevice.deviceId;
        else if (videoDevices.length > 1) targetDeviceId = videoDevices[videoDevices.length - 1].deviceId;

        const constraints = {
            audio: false,
            video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        };
        if (targetDeviceId) constraints.video.deviceId = { exact: targetDeviceId };
        else constraints.video.facingMode = 'environment';

        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        const videoTrack = cameraStream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
        
        if (capabilities.zoom) {
            try { await videoTrack.applyConstraints({ advanced: [{ zoom: capabilities.zoom.min }] }); }
            catch (e) { console.warn(e); }
        }

        video.srcObject = cameraStream;
        video.play();
        startBtn.style.display = 'none';
        
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            // 初期化
            src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
            dst = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
            hsv = new cv.Mat(); mask = new cv.Mat();
            contours = new cv.MatVector(); hierarchy = new cv.Mat();

            // バッファのリセット
            detectionHistory.fill(false);
            historyIndex = 0;
            lockCounter = 0;

            isProcessing = true;
            statusText.innerText = "緑の丸4つを画面内に収めてください";
            animationFrameId = requestAnimationFrame(processVideo);
        };
    } catch (error) {
        statusText.innerText = "カメラ起動失敗: " + error.message;
    }
});

function startRecordingSystem() {
    let options = { mimeType: 'video/mp4; codecs=avc1' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm; codecs=vp9' };
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: '' }; 
    }

    mediaRecorder = new MediaRecorder(cameraStream, options);

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            saveChunkToDB(event.data);
        }
    };

    mediaRecorder.onstop = async () => {
        try {
            statusText.innerText = "ストレージから動画データを収集中...";
            const chunks = await getAllChunksFromDB();
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/mp4' });
            
            statusText.innerText = "動画ファイルをダウンロード処理中...";
            triggerSecureDownload(blob);
        } catch (err) {
            statusText.innerText = "動画生成エラー: " + err.message;
        }
    };

    mediaRecorder.start(1000);
    isRecording = true;
    stopRecordBtn.style.display = 'block';
}

function triggerSecureDownload(blobData) {
    const ext = (mediaRecorder.mimeType && mediaRecorder.mimeType.includes('webm')) ? 'webm' : 'mp4';
    const url = URL.createObjectURL(blobData);
    
    const a = document.createElement('a');
    a.href = url;
    const nowTime = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `experiment-video-${nowTime}.${ext}`;
    
    document.body.appendChild(a);
    
    const clickEvent = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true
    });
    a.dispatchEvent(clickEvent);
    
    document.body.removeChild(a);
    
    setTimeout(() => {
        URL.revokeObjectURL(url);
        clearDatabase();
    }, 1000);

    statusText.innerHTML = `<span style="color: #34c759; font-size: 18px;">■ 録画を安全に終了しました。<br>「ファイル」アプリの「ダウンロード」を確認してください。</span>`;
}

stopRecordBtn.addEventListener('click', () => {
    if (isRecording) {
        isRecording = false;
        stopRecordBtn.style.display = 'none';
        
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop(); 
        }

        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
        }
        if (video) {
            video.srcObject = null;
        }

        // 認識途中で手動停止された場合のメモリ解放 (メモリリーク対策)
        deleteAllMats();

        ctx.fillStyle = "#222";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        statusText.innerText = "ストレージからデータを処理しています。しばらくお待ちください...";
    }
});

function processVideo() {
    if (!isProcessing) return;

    if (!isRecording) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        src.data.set(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        cv.GaussianBlur(src, dst, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
        cv.cvtColor(dst, hsv, cv.COLOR_RGBA2RGB);
        cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

        let low = cv.matFromArray(3, 1, cv.CV_8U, [35, 60, 50]);
        let high = cv.matFromArray(3, 1, cv.CV_8U, [85, 255, 255]);
        cv.inRange(hsv, low, high, mask);
        low.delete(); high.delete();

        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        
        let allCandidates = [];

        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let area = cv.contourArea(cnt);
            
            if (area < 500) { // 小さい丸の中から探す仕様
                let perimeter = cv.arcLength(cnt, true);
                if (perimeter > 0) {
                    let circularity = (4 * Math.PI * area) / (perimeter * perimeter);
                    
                    if (circularity > 0.8) { 
                        let M = cv.moments(cnt);
                        if (M.m00 !== 0) {
                            allCandidates.push({
                                area: area,
                                x: M.m10 / M.m00,
                                y: M.m01 / M.m00
                            });
                        }
                    }
                }
            }
            cnt.delete(); // ループ内の輪郭データを確実に毎フレーム解放 (メモリリーク対策)
        }

        allCandidates.sort((a, b) => b.area - a.area);
        let validCenters = allCandidates.slice(0, 4);

        // --- 改良版ブレ対策（打率制ロジック） ---
        // 今回のフレームで「合格した小さな丸が4つ揃ったか」を履歴バッファに記憶
        const isDetectedThisFrame = (validCenters.length === 4);
        detectionHistory[historyIndex] = isDetectedThisFrame;
        historyIndex = (historyIndex + 1) % BUFFER_SIZE;

        // 直近30フレーム中、何回成功しているかをカウント
        const successCount = detectionHistory.filter(Boolean).length;
        // 打率が8割以上（30フレーム中25フレーム以上成功）なら「安定」とみなす
        const isStable = (successCount >= 25);

        if (isStable) {
            lockCounter++; // 安定している間、カウントアップ

            // 画面上に緑枠の四角形を描画
            validCenters.sort((a, b) => a.y - b.y);
            let topTwo = [validCenters[0], validCenters[1]].sort((a, b) => a.x - b.x);
            let bottomTwo = [validCenters[2], validCenters[3]].sort((a, b) => a.x - b.x);
            const pts = [topTwo[0], topTwo[1], bottomTwo[1], bottomTwo[0]];

            ctx.strokeStyle = '#34c759'; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            ctx.lineTo(pts[1].x, pts[1].y); ctx.lineTo(pts[2].x, pts[2].y);
            ctx.lineTo(pts[3].x, pts[3].y); ctx.closePath(); ctx.stroke();

            if (lockCounter >= REQUIRED_FRAMES) {
                // 自動録画開始時のメモリ解放 (メモリリーク対策)
                deleteAllMats();
                
                isProcessing = false;
                if (animationFrameId) cancelAnimationFrame(animationFrameId);

                canvas.classList.add('locked');
                statusText.innerHTML = `<span style="color: #ff3b30;">🔴 長時間実験映像を録画中...</span>`;

                startRecordingSystem();
                return; 
            } else {
                let timeLeft = Math.ceil((REQUIRED_FRAMES - lockCounter) / 30);
                statusText.innerHTML = `🟡 4点安定検知中（打率: ${successCount}/${BUFFER_SIZE}）... あと <span style="color: #ffcc00; font-size: 20px;">${timeLeft}</span> 秒`;
            }
        } else {
            // 一瞬ブレて打率が下がっても、lockCounterをすぐ0にせず維持するか、あるいは減算にする（今回はリセットしつつも復帰しやすく）
            lockCounter = 0;
            canvas.classList.remove('locked');
            statusText.innerHTML = `🔍 マーカーを収めてください（直近の検出率: ${successCount}/${BUFFER_SIZE}）`;
            
            // 見つかっている点だけ赤丸でプレビュー表示
            ctx.fillStyle = 'red';
            for(let p of validCenters) {
                ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI); ctx.fill();
            }
        }
    }

    if (isProcessing) {
        animationFrameId = requestAnimationFrame(processVideo);
    }
}
