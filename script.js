const video = document.getElementById('camera-view');
const canvas = document.getElementById('canvas-output');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('start-btn');
const stopRecordBtn = document.getElementById('stop-record-btn');
const statusText = document.getElementById('status');

let src, dst, hsv, mask, contours, hierarchy;
let isProcessing = false;

let lockCounter = 0;
const REQUIRED_FRAMES = 150; // 5秒間安定

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

// データをクリア
function clearDatabase() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

// 動画の断片(Chunk)を物理ストレージに保存
function saveChunkToDB(chunk) {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.add(chunk);
}

// 保存された全データを取得
function getAllChunksFromDB() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}
// ---------------------------------

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
        await clearDatabase(); // 録画開始前に前回のデータをクリーンアップ

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
            
            src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
            dst = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
            hsv = new cv.Mat(); mask = new cv.Mat();
            contours = new cv.MatVector(); hierarchy = new cv.Mat();

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

        // 元の「動きやすかった」閾値に完全に戻す
        let low = cv.matFromArray(3, 1, cv.CV_8U, [35, 60, 50]);
        let high = cv.matFromArray(3, 1, cv.CV_8U, [85, 255, 255]);
        cv.inRange(hsv, low, high, mask);
        low.delete(); high.delete();

        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        
        let allCandidates = [];

        // ステップ1: まずは緑色っぽくて、ある程度丸いものをすべてリストアップする
        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let area = cv.contourArea(cnt);
            
            if (area < 500) { // 最低限のノイズカット（下限のみ）
                let perimeter = cv.arcLength(cnt, true);
                if (perimeter > 0) {
                    let circularity = (4 * Math.PI * area) / (perimeter * perimeter);
                    
                    // しっかり丸い形をしているものだけを候補にする（大きな四角い物体などをここで弾く）
                    if (circularity > 0.8) { 
                        let M = cv.moments(cnt);
                        if (M.m00 !== 0) {
                            allCandidates.push({
                                area: area, // 面積を記憶
                                x: M.m10 / M.m00,
                                y: M.m01 / M.m00
                            });
                        }
                    }
                }
            }
            cnt.delete();
        }

        // ★新ロジック: 候補を「面積が大きい順（降順）」に並び替える
        allCandidates.sort((a, b) => b.area - a.area);

        // 上位4つだけを「本物のマーカー」として抽出する
        let validCenters = allCandidates.slice(0, 4);

        // 最終的に「合格した大きな丸」が4つ揃っていれば確定
        if (validCenters.length === 4) {
            lockCounter++;
            validCenters.sort((a, b) => a.y - b.y);
            let topTwo = [validCenters[0], validCenters[1]].sort((a, b) => a.x - b.x);
            let bottomTwo = [validCenters[2], validCenters[3]].sort((a, b) => a.x - b.x);
            const pts = [topTwo[0], topTwo[1], bottomTwo[1], bottomTwo[0]];

            ctx.strokeStyle = '#34c759'; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            ctx.lineTo(pts[1].x, pts[1].y); ctx.lineTo(pts[2].x, pts[2].y);
            ctx.lineTo(pts[3].x, pts[3].y); ctx.closePath(); ctx.stroke();

            if (lockCounter >= REQUIRED_FRAMES) {
                src.delete(); dst.delete(); hsv.delete(); mask.delete(); contours.delete(); hierarchy.delete();
                
                isProcessing = false;
                if (animationFrameId) cancelAnimationFrame(animationFrameId);

                canvas.classList.add('locked');
                statusText.innerHTML = `<span style="color: #ff3b30;">🔴 長時間実験映像を録画中...</span>`;

                startRecordingSystem();
                return; 
            } else {
                let timeLeft = Math.ceil((REQUIRED_FRAMES - lockCounter) / 30);
                statusText.innerHTML = `🟡 4点捕捉中... 画角安定まであと <span style="color: #ffcc00; font-size: 20px;">${timeLeft}</span> 秒`;
            }
        } else {
            lockCounter = 0;
            canvas.classList.remove('locked');
            statusText.innerHTML = `🔍 マーカーを探しています... (${validCenters.length} / 4)`;
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
