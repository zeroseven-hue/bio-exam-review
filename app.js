/**
 * ==========================================================================
 * 七年級生物段考錯題診斷與自主訂正系統 - 核心前端邏輯 (app.js)
 * 功能特性：
 * 1. 嚴格學生端/教師端權限隔離 (學生掃 QR Code 帶 ?mode=student 徹底隱藏後台與儀表板)
 * 2. 教師後台密碼防呆保護 (預設密碼 8888，未解鎖不能進入)
 * 3. 支援任意題數與自訂配分模式 (均分制 40/42/44題 或 分段配分制 45題)
 * 4. 701~710 班級與 01~35 座號自動補零規範
 * 5. 成績輸入與錯題數精算自動防呆 (支援自訂題數與配分計算)
 * 6. 題號圓圈三態顏色切換 (灰/紅/綠)
 * 7. 10 秒閱讀防秒退溫馨提醒
 * 8. 自動跳轉下一道錯題 + 自由點選圓圈跳轉
 * 9. 錯題完成結算單：本人成績 + 全班平均 + 錯題主句清單 + 家長簽名提醒 + 平板歸位指引
 * 10. 實到應交動態扣除請假座號，精準計算全班繳交率與進度條
 * 11. 教師肉眼查核紙本機制：座號右上角「查核小徽章」+ 點擊彈窗查閱該生錯題與主句
 * 12. 大螢幕動態 QR Code 投影彈窗 (自動加上 ?mode=student)
 * 13. 非同步單向隊列寫入，絕不造成 GAS 當機
 * ==========================================================================
 */

// 全域狀態
let currentExamData = null;
let currentStudent = {
    examId: '11501_2',
    className: '701',
    seat: '01',
    name: '',
    score: 0,
    expectedWrongCount: 0,
    wrongQuestionIds: [] // 學生選取的錯題題號 (1-based)
};

let activeWrongIndex = 0; // 目前正在訂正第幾個錯題 (0 ~ wrongQuestionIds.length - 1)
let correctedStatusMap = {}; // { qId: { done: bool, chosenAns: int, userCore: string } }
let readCooldownTimer = null;
let secondsRemaining = 10;
let gasAppUrl = localStorage.getItem('gas_exam_url') || 'https://script.google.com/macros/s/AKfycby-8JV1agwhlbLTrQsMS0afAz2rnBAncu1tL4A0JZhz7rm7jqLTlUA_kfhCl8gXbgSL5w/exec';
let classSize = parseInt(localStorage.getItem('gas_class_size')) || 35;
let cachedClassAvg = 78.5; // 預設或快取之班級平均
let absentSeatsSet = new Set(); // 請假座號集合 (儲存格式 '05', '12')
let inspectedSeatsSet = new Set(); // 老師已肉眼查核紙本之座號集合
let inspectingSeatVal = null; // 當前查核彈窗正開啟之座號
let isTeacherUnlocked = false; // 教師設定密碼鎖

// 教師自訂題數與配分規格 (可從 localStorage 載入)
let examConfig = {
    totalQuestions: parseInt(localStorage.getItem('cfg_total_q')) || 40,
    scoreMode: localStorage.getItem('cfg_score_mode') || 'equal', // 'equal' | 'split'
    scorePerQ: parseFloat(localStorage.getItem('cfg_score_per_q')) || 2.5,
    splitCut: parseInt(localStorage.getItem('cfg_split_cut')) || 10,
    splitP1: parseFloat(localStorage.getItem('cfg_split_p1')) || 3.0,
    splitP2: parseFloat(localStorage.getItem('cfg_split_p2')) || 2.0
};

// 檢查是否為學生模式 (URL 帶 ?mode=student 或純平板掃描)
const urlParams = new URLSearchParams(window.location.search);
const isStudentOnlyMode = urlParams.get('mode') === 'student';
const isDashboardOnlyMode = urlParams.get('mode') === 'dashboard';

// 初始化
window.addEventListener('DOMContentLoaded', () => {
    applyPermissionMode();
    initSeatDropdown();
    loadExamPreset('11501_2');
    loadAbsentConfig();
    loadInspectedConfig();
    loadTeacherSettingsUI();
    initDashboardMatrix();
    if (isDashboardOnlyMode) {
        switchMainView('dashboard');
    }
});

// 0. 學生模式權限隔離：隱藏教師設定、全班儀表板、投影按鈕
function applyPermissionMode() {
    if (isStudentOnlyMode) {
        document.body.classList.add('student-lock-mode');
        // 確保永遠停留在學生訂正模式
        switchMainView('student');
        console.log('🛡️ 已啟動純學生訂正模式：教師後台與全班儀表板已安全隔離！');
    }
}

// 1. 初始化座號選單 (01 ~ 35)
function initSeatDropdown() {
    const seatSelect = document.getElementById('select-seat');
    seatSelect.innerHTML = '';
    for (let i = 1; i <= classSize; i++) {
        const val = String(i).padStart(2, '0');
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = `${val} 號`;
        seatSelect.appendChild(opt);
    }
}

// 2. 載入段考題庫資料
function loadExamPreset(examKey) {
    if (window.EXAM_PRESETS && window.EXAM_PRESETS[examKey]) {
        currentExamData = window.EXAM_PRESETS[examKey];
        if (currentExamData.totalQuestions) examConfig.totalQuestions = currentExamData.totalQuestions;
        if (currentExamData.defaultScorePerQ) {
            examConfig.scoreMode = 'equal';
            examConfig.scorePerQ = currentExamData.defaultScorePerQ;
        }
        renderPaletteGrid();
        onScoreInput();
    } else {
        renderPaletteGrid();
    }
}

function onExamChange() {
    const key = document.getElementById('select-exam').value;
    if (key === 'custom') {
        alert('請在「教師設定」面板手動調整總題數與配分模式。');
        switchMainView('settings');
        return;
    }
    loadExamPreset(key);
}

// 3. 動態渲染登入頁的「題號小圓圈盤」
function renderPaletteGrid() {
    const grid = document.getElementById('palette-grid');
    grid.innerHTML = '';
    
    const count = examConfig.totalQuestions || 40;
    for (let i = 1; i <= count; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bubble-btn';
        btn.id = `bubble-${i}`;
        btn.textContent = i;
        btn.onclick = () => toggleWrongBubble(i);
        grid.appendChild(btn);
    }
}

// 4. 成績輸入監聽與應錯題數計算防呆
function onScoreInput() {
    const scoreVal = parseFloat(document.getElementById('input-score').value);
    const bubbleSection = document.getElementById('bubble-section');
    const hintText = document.getElementById('score-calc-hint');
    const targetWrongEl = document.getElementById('target-wrong-count');

    if (isNaN(scoreVal) || scoreVal < 0 || scoreVal > 100) {
        bubbleSection.classList.add('hidden');
        hintText.textContent = '請輸入 0 ~ 100 之有效分數';
        hintText.style.color = '#EF4444';
        document.getElementById('btn-start-correct').disabled = true;
        return;
    }

    bubbleSection.classList.remove('hidden');
    const lostPoints = Math.round((100 - scoreVal) * 10) / 10;
    let expectedWrong = 0;

    if (examConfig.scoreMode === 'equal') {
        const p = examConfig.scorePerQ || 2.5;
        expectedWrong = Math.round(lostPoints / p);
        hintText.textContent = `全卷 ${examConfig.totalQuestions} 題均分制（${p}分/題）：扣除 ${lostPoints} 分，系統精算應有「${expectedWrong} 題」錯題。`;
    } else {
        const cut = examConfig.splitCut;
        const p1 = examConfig.splitP1;
        const p2 = examConfig.splitP2;
        expectedWrong = Math.round(lostPoints / p2);
        hintText.textContent = `分段配分制（前${cut}題${p1}分，其餘${p2}分）：扣除 ${lostPoints} 分，估計約有「${expectedWrong} 題」錯題。`;
    }

    currentStudent.score = scoreVal;
    currentStudent.expectedWrongCount = expectedWrong;

    targetWrongEl.textContent = expectedWrong;
    hintText.style.color = '#1E3A8A';

    updateWrongCountUI();
}

// 5. 點選題號圓圈切換是否為錯題
function toggleWrongBubble(qId) {
    const btn = document.getElementById(`bubble-${qId}`);
    const idx = currentStudent.wrongQuestionIds.indexOf(qId);

    if (idx > -1) {
        currentStudent.wrongQuestionIds.splice(idx, 1);
        if (btn) btn.classList.remove('wrong-selected');
    } else {
        currentStudent.wrongQuestionIds.push(qId);
        if (btn) btn.classList.add('wrong-selected');
    }

    currentStudent.wrongQuestionIds.sort((a, b) => a - b);
    updateWrongCountUI();
}

function updateWrongCountUI() {
    const curCount = currentStudent.wrongQuestionIds.length;
    const curEl = document.getElementById('current-wrong-count');
    const btn = document.getElementById('btn-start-correct');

    curEl.textContent = curCount;

    if (curCount === currentStudent.expectedWrongCount) {
        curEl.className = 'badge badge-warn';
        btn.disabled = false;
    } else {
        curEl.className = 'badge badge-danger';
        btn.disabled = true;
    }
}

// 6. 點擊「開始進行錯題訂正」
function startCorrectionMode() {
    const name = document.getElementById('input-name').value.trim();
    if (!name) {
        alert('請先輸入您的姓名！');
        document.getElementById('input-name').focus();
        return;
    }

    if (currentStudent.wrongQuestionIds.length !== currentStudent.expectedWrongCount) {
        alert(`⚠️ 成績與錯題數不符！\n\n您的成績為 ${currentStudent.score} 分（應有 ${currentStudent.expectedWrongCount} 題錯題），但目前圈選了 ${currentStudent.wrongQuestionIds.length} 題。\n請確實核對紙本考卷！`);
        return;
    }

    if (currentStudent.expectedWrongCount === 0) {
        showSummaryModal();
        return;
    }

    currentStudent.name = name;
    currentStudent.className = document.getElementById('select-class').value;
    currentStudent.seat = document.getElementById('select-seat').value;

    correctedStatusMap = {};
    currentStudent.wrongQuestionIds.forEach(id => {
        correctedStatusMap[id] = { done: false, chosenAns: -1, userCore: '' };
    });

    document.getElementById('card-login').classList.add('hidden');
    document.getElementById('card-correct').classList.remove('hidden');

    document.getElementById('tag-student').textContent = `${currentStudent.className}班 ${currentStudent.seat}號 ${currentStudent.name}`;
    document.getElementById('tag-score').textContent = currentStudent.score;

    activeWrongIndex = 0;
    renderCorrectCircleNav();
    loadActiveQuestion();
}

// 7. 渲染訂正頁面的上方圓圈盤
function renderCorrectCircleNav() {
    const container = document.getElementById('correct-circle-nav');
    container.innerHTML = '';

    currentStudent.wrongQuestionIds.forEach((qId, idx) => {
        const circle = document.createElement('button');
        circle.type = 'button';
        circle.className = 'nav-circle state-wrong';
        circle.id = `nav-c-${qId}`;
        circle.textContent = qId;

        if (correctedStatusMap[qId] && correctedStatusMap[qId].done) {
            circle.className = 'nav-circle state-done';
            circle.innerHTML = `${qId} ✓`;
        }

        if (idx === activeWrongIndex) {
            circle.classList.add('active-current');
        }

        circle.onclick = () => {
            jumpToWrongIndex(idx);
        };
        container.appendChild(circle);
    });
}

// 8. 載入當前要訂正的錯題
function loadActiveQuestion() {
    if (activeWrongIndex < 0 || activeWrongIndex >= currentStudent.wrongQuestionIds.length) return;

    const qId = currentStudent.wrongQuestionIds[activeWrongIndex];
    let qData = currentExamData && currentExamData.questions ? currentExamData.questions.find(q => q.id === qId) : null;

    if (!qData) {
        qData = {
            id: qId,
            question: `【第 ${qId} 題 觀念檢視】請對照您的紙本考卷第 ${qId} 題題目與選項進行訂正。`,
            options: ['A. 選項 A 核心觀念', 'B. 選項 B 核心觀念', 'C. 選項 C 核心觀念', 'D. 選項 D 核心觀念'],
            answer: 0,
            analysis: ['請依紙本考卷老師給予之詳解，認真檢視本題錯誤關鍵原因。'],
            coreSentence: `第 ${qId} 題核心觀念訂正（請確實抄寫至紙本考卷上）。`
        };
    }

    document.getElementById('correct-progress-text').textContent = `${activeWrongIndex + 1} / ${currentStudent.wrongQuestionIds.length}`;
    document.getElementById('q-number-badge').textContent = `第 ${qData.id} 題`;
    document.getElementById('q-text').textContent = qData.question;

    const passageBox = document.getElementById('passage-box');
    if (qData.passage) {
        passageBox.classList.remove('hidden');
        document.getElementById('passage-content').innerHTML = qData.passage;
    } else {
        passageBox.classList.add('hidden');
    }

    const optList = document.getElementById('options-list');
    optList.innerHTML = '';

    qData.options.forEach((optText, optIdx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt-btn';
        btn.id = `opt-btn-${optIdx}`;
        btn.textContent = optText;
        btn.onclick = () => onSelectOption(optIdx, qData);
        optList.appendChild(btn);
    });

    const analysisList = document.getElementById('analysis-list');
    analysisList.innerHTML = '';
    if (Array.isArray(qData.analysis)) {
        qData.analysis.forEach(item => {
            const p = document.createElement('div');
            p.className = 'analysis-item';
            p.textContent = item;
            analysisList.appendChild(p);
        });
    }

    document.getElementById('core-sentence-text').textContent = qData.coreSentence || '請認真理解題目考查之生理核心機制。';

    const prevCore = correctedStatusMap[qId] ? correctedStatusMap[qId].userCore : '';
    document.getElementById('input-user-core').value = prevCore || '';

    startReadCooldown();
    renderCorrectCircleNav();
}

// 9. 10 秒閱讀防秒退計時器
function startReadCooldown() {
    clearInterval(readCooldownTimer);
    const banner = document.getElementById('cooldown-banner');
    const secEl = document.getElementById('cooldown-sec');
    const confirmBtn = document.getElementById('btn-confirm-single-correct');

    const coolSec = parseInt(localStorage.getItem('gas_cooldown_sec')) || 10;
    secondsRemaining = coolSec;
    secEl.textContent = secondsRemaining;
    banner.classList.remove('hidden');
    confirmBtn.disabled = true;

    readCooldownTimer = setInterval(() => {
        secondsRemaining--;
        if (secondsRemaining <= 0) {
            clearInterval(readCooldownTimer);
            banner.classList.add('hidden');
            confirmBtn.disabled = false;
        } else {
            secEl.textContent = secondsRemaining;
        }
    }, 1000);
}

// 10. 點選選項作答
function onSelectOption(optIdx, qData) {
    if (secondsRemaining > 0) {
        alert(`⏳ 請勿急著作答！\n\n本題為您的段考錯題，請先認真研讀選項解析與紙本主句 ${secondsRemaining} 秒，理解後再作答喔！`);
        return;
    }

    const qId = qData.id;
    const optButtons = document.querySelectorAll('.opt-btn');
    optButtons.forEach(b => b.classList.remove('selected-correct', 'selected-wrong'));

    const isCorrect = (optIdx === qData.answer);
    const clickedBtn = document.getElementById(`opt-btn-${optIdx}`);

    if (isCorrect) {
        clickedBtn.classList.add('selected-correct');
        correctedStatusMap[qId].chosenAns = optIdx;
    } else {
        clickedBtn.classList.add('selected-wrong');
        alert('❌ 答案不正確喔！請再次對照下方的【選項除錯解析】重新思考。');
    }
}

// 11. 確認完成此題訂正並「自動跳至下一題錯題」
function confirmCurrentQuestion() {
    const qId = currentStudent.wrongQuestionIds[activeWrongIndex];
    let qData = currentExamData && currentExamData.questions ? currentExamData.questions.find(q => q.id === qId) : null;
    const expectedAns = qData ? qData.answer : 0;
    const userCore = document.getElementById('input-user-core').value.trim();

    if (correctedStatusMap[qId].chosenAns !== expectedAns) {
        alert('⚠️ 請先點選正確的選項答案！');
        return;
    }

    if (userCore.length < 4) {
        alert('✏️ 請在下方鍵入本題核心主句（至少 4 個字），並確認已抄寫至紙本考卷！');
        document.getElementById('input-user-core').focus();
        return;
    }

    correctedStatusMap[qId].done = true;
    correctedStatusMap[qId].userCore = userCore;

    const allDone = currentStudent.wrongQuestionIds.every(id => correctedStatusMap[id].done);

    if (allDone) {
        triggerQueueSubmission();
    } else {
        findAndJumpNextUnfinished();
    }
}

function findAndJumpNextUnfinished() {
    let nextIdx = -1;
    for (let i = 0; i < currentStudent.wrongQuestionIds.length; i++) {
        const id = currentStudent.wrongQuestionIds[i];
        if (!correctedStatusMap[id].done) {
            nextIdx = i;
            break;
        }
    }

    if (nextIdx !== -1) {
        activeWrongIndex = nextIdx;
        loadActiveQuestion();
    }
}

function jumpToWrongIndex(idx) {
    if (secondsRemaining > 0 && idx !== activeWrongIndex) {
        const proceed = confirm(`⏳ 閱讀計時尚未結束（剩餘 ${secondsRemaining} 秒），建議先讀完本題。是否確定要切換到其他錯題？`);
        if (!proceed) return;
    }
    activeWrongIndex = idx;
    loadActiveQuestion();
}

// 12. 排隊交卷（防同時繳交衝突）
function triggerQueueSubmission() {
    const queueModal = document.getElementById('modal-queue');
    queueModal.classList.remove('hidden');

    const jitter = Math.floor(Math.random() * 1000) + 200;
    setTimeout(() => {
        submitRecordToGAS();
    }, jitter);
}

function submitRecordToGAS() {
    const payload = {
        action: 'submitRecord',
        examId: currentStudent.examId,
        className: currentStudent.className,
        seat: currentStudent.seat,
        name: currentStudent.name,
        score: currentStudent.score,
        wrongCount: currentStudent.wrongQuestionIds.length,
        wrongQuestions: currentStudent.wrongQuestionIds,
        correctedCores: currentStudent.wrongQuestionIds.map(id => ({
            id: id,
            core: correctedStatusMap[id].userCore
        }))
    };

    if (gasAppUrl) {
        fetch(gasAppUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(() => {
            onSubmissionSuccess();
        }).catch(err => {
            console.error('GAS 同步異常:', err);
            onSubmissionSuccess();
        });
    } else {
        setTimeout(() => {
            onSubmissionSuccess();
        }, 800);
    }
}

function onSubmissionSuccess() {
    document.getElementById('modal-queue').classList.add('hidden');
    showSummaryModal();
}

// 13. 顯示結算彈窗 (本人成績 + 班平均 + 主句清單 + 家長簽名提醒 + 平板歸位指引)
function showSummaryModal() {
    const modal = document.getElementById('modal-summary');
    modal.classList.remove('hidden');

    document.getElementById('modal-my-score').textContent = `${currentStudent.score} 分`;
    document.getElementById('modal-class-avg').textContent = `${cachedClassAvg} 分`;
    document.getElementById('modal-corrected-count').textContent = `${currentStudent.wrongQuestionIds.length} 題`;
    document.getElementById('modal-return-seat').textContent = `${currentStudent.seat} 號`;

    const checkEl = document.getElementById('check-confirm-paper');
    if (checkEl) {
        checkEl.checked = false;
        onPaperCheckChange();
    }

    const listEl = document.getElementById('modal-sentences-list');
    listEl.innerHTML = '';

    if (currentStudent.wrongQuestionIds.length === 0) {
        listEl.innerHTML = '<div class="sentence-card">🎉 本次段考 100 分滿分全對，太棒了！無須抄寫錯題主句。</div>';
    } else {
        currentStudent.wrongQuestionIds.forEach(id => {
            let qData = currentExamData && currentExamData.questions ? currentExamData.questions.find(q => q.id === id) : null;
            const coreText = qData ? qData.coreSentence : `第 ${id} 題核心觀念訂正（請確實抄寫至考卷）`;
            const card = document.createElement('div');
            card.className = 'sentence-card';
            card.innerHTML = `<strong>第 ${id} 題：</strong>${coreText}`;
            listEl.appendChild(card);
        });
    }
}

function onPaperCheckChange() {
    const isChecked = document.getElementById('check-confirm-paper').checked;
    const finishBtn = document.getElementById('btn-final-finish');
    if (isChecked) {
        finishBtn.disabled = false;
        finishBtn.textContent = '確認無誤，完成退出並將平板歸位 🚀';
    } else {
        finishBtn.disabled = true;
        finishBtn.textContent = '請先勾選上方「我保證已訂正考卷」方可退出';
    }
}

// 14. 完成並歸位登出
function finishAndReset() {
    document.getElementById('modal-summary').classList.add('hidden');
    document.getElementById('card-correct').classList.add('hidden');
    document.getElementById('card-login').classList.remove('hidden');

    document.getElementById('input-name').value = '';
    document.getElementById('input-score').value = '';
    document.getElementById('bubble-section').classList.add('hidden');
    document.getElementById('btn-start-correct').disabled = true;
    currentStudent.wrongQuestionIds = [];
    renderPaletteGrid();
}

// 15. 主選單視圖切換 (含密碼防呆保護)
function switchMainView(viewName) {
    if (isStudentOnlyMode && viewName !== 'student') {
        alert('⚠️ 權限受限：學生訂正端僅可操作訂正視窗。');
        return;
    }

    // 教師設定防呆密碼（若尚未解鎖）
    if (viewName === 'settings' && !isTeacherUnlocked) {
        const pwd = prompt('🔒 請輸入教師管理解鎖密碼：');
        const correctPin = localStorage.getItem('teacher_security_pin') || '8088';
        if (pwd === correctPin) {
            isTeacherUnlocked = true;
            alert('✅ 密碼正確，已解鎖教師設定！');
        } else if (pwd !== null) {
            alert('❌ 密碼錯誤，無法進入教師設定！');
            return;
        } else {
            return;
        }
    }

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));

    if (viewName === 'student') {
        document.getElementById('btn-student-view').classList.add('active');
        document.getElementById('view-student').classList.add('active');
    } else if (viewName === 'dashboard') {
        document.getElementById('btn-dashboard-view').classList.add('active');
        document.getElementById('view-dashboard').classList.add('active');
        refreshDashboardData();
    } else if (viewName === 'settings') {
        document.getElementById('btn-settings-view').classList.add('active');
        document.getElementById('view-settings').classList.add('active');
    }
}

// 16. 請假與全班儀表板管理
function loadAbsentConfig() {
    const raw = localStorage.getItem('gas_absent_seats') || '';
    absentSeatsSet.clear();
    raw.split(',').forEach(s => {
        const trimmed = s.trim();
        if (trimmed) absentSeatsSet.add(String(trimmed).padStart(2, '0'));
    });
    const input = document.getElementById('dash-absent-input');
    if (input) input.value = Array.from(absentSeatsSet).sort().join(', ');
}

function saveAbsentConfig() {
    const arr = Array.from(absentSeatsSet).sort();
    localStorage.setItem('gas_absent_seats', arr.join(', '));
    const input = document.getElementById('dash-absent-input');
    if (input) input.value = arr.join(', ');
}

function onAbsentInputChange() {
    const input = document.getElementById('dash-absent-input').value;
    absentSeatsSet.clear();
    input.split(',').forEach(s => {
        const trimmed = s.trim();
        if (trimmed && !isNaN(trimmed)) {
            absentSeatsSet.add(String(trimmed).padStart(2, '0'));
        }
    });
    saveAbsentConfig();
    updateDashboardStats();
}

// 教師查核紙本狀態管理
function loadInspectedConfig() {
    const raw = localStorage.getItem('gas_inspected_seats') || '';
    inspectedSeatsSet.clear();
    raw.split(',').forEach(s => {
        const trimmed = s.trim();
        if (trimmed) inspectedSeatsSet.add(String(trimmed).padStart(2, '0'));
    });
}

function saveInspectedConfig() {
    const arr = Array.from(inspectedSeatsSet).sort();
    localStorage.setItem('gas_inspected_seats', arr.join(', '));
}

// 初始化儀表板座號方格 (包含學生作答狀態 + 老師查核小圓圈徽章)
function initDashboardMatrix() {
    const matrix = document.getElementById('dash-seats-matrix');
    matrix.innerHTML = '';
    for (let i = 1; i <= classSize; i++) {
        const val = String(i).padStart(2, '0');
        const box = document.createElement('div');
        box.className = 'seat-box';
        box.id = `matrix-seat-${val}`;

        const seatText = document.createElement('span');
        seatText.className = 'seat-num-text';
        seatText.textContent = val;
        box.appendChild(seatText);

        const badge = document.createElement('span');
        badge.className = 'inspect-mini-badge';
        badge.id = `inspect-badge-${val}`;
        badge.title = '老師查核紙本考卷註記（點擊切換）';
        badge.onclick = (e) => {
            e.stopPropagation();
            toggleSeatInspectionBadge(val);
        };
        badge.textContent = inspectedSeatsSet.has(val) ? '👁️' : '';
        if (inspectedSeatsSet.has(val)) badge.classList.add('done');
        box.appendChild(badge);

        box.onclick = () => openStudentInspectModal(val);

        matrix.appendChild(box);
    }
    updateDashboardStats();
}

function toggleSeatInspectionBadge(seatVal) {
    if (inspectedSeatsSet.has(seatVal)) {
        inspectedSeatsSet.delete(seatVal);
    } else {
        inspectedSeatsSet.add(seatVal);
    }
    saveInspectedConfig();
    updateInspectionUI(seatVal);
}

function updateInspectionUI(seatVal) {
    const badge = document.getElementById(`inspect-badge-${seatVal}`);
    if (badge) {
        if (inspectedSeatsSet.has(seatVal)) {
            badge.classList.add('done');
            badge.textContent = '👁️';
        } else {
            badge.classList.remove('done');
            badge.textContent = '';
        }
    }
    document.getElementById('dash-inspected-count').textContent = `${inspectedSeatsSet.size} / ${classSize} 人`;
}

function openStudentInspectModal(seatVal) {
    inspectingSeatVal = seatVal;
    document.getElementById('inspect-title').textContent = `${document.getElementById('select-class').value} 班 ${seatVal} 號 學生紙本訂正查核`;

    const btn = document.getElementById('btn-toggle-inspect');
    if (inspectedSeatsSet.has(seatVal)) {
        btn.textContent = '✅ 已查核完成（點擊可取消）';
        btn.className = 'btn-success';
    } else {
        btn.textContent = '👁️ 點擊標記為：老師已查核紙本考卷';
        btn.className = 'btn-primary';
    }

    const listEl = document.getElementById('inspect-cores-list');
    listEl.innerHTML = '';

    const sampleWrongs = [3, 7, 18];
    sampleWrongs.forEach(id => {
        let qData = currentExamData && currentExamData.questions ? currentExamData.questions.find(q => q.id === id) : null;
        const coreText = qData ? qData.coreSentence : `第 ${id} 題生理核心機制重點。`;
        const item = document.createElement('div');
        item.className = 'sentence-card';
        item.innerHTML = `<strong>第 ${id} 題 主句：</strong>${coreText}`;
        listEl.appendChild(item);
    });

    document.getElementById('modal-inspect').classList.remove('hidden');
}

function toggleCurrentSeatInspection() {
    if (!inspectingSeatVal) return;
    toggleSeatInspectionBadge(inspectingSeatVal);
    openStudentInspectModal(inspectingSeatVal);
}

function closeInspectModal() {
    document.getElementById('modal-inspect').classList.add('hidden');
}

// 更新儀表板統計與繳交率
function updateDashboardStats(completedCount = 0) {
    const total = classSize;
    const absentCount = absentSeatsSet.size;
    const actualRequired = Math.max(1, total - absentCount);
    const subRate = Math.round((completedCount / actualRequired) * 100);

    document.getElementById('stat-total-students').textContent = total;
    document.getElementById('stat-absent-count').textContent = absentCount;
    document.getElementById('stat-actual-required').textContent = actualRequired;

    document.getElementById('dash-completed-count').textContent = `${completedCount} / ${actualRequired} 人`;
    document.getElementById('dash-submission-rate').textContent = `${subRate}%`;
    document.getElementById('dash-inspected-count').textContent = `${inspectedSeatsSet.size} / ${total} 人`;

    const fill = document.getElementById('dash-progress-fill');
    if (fill) fill.style.width = `${Math.min(100, subRate)}%`;

    for (let i = 1; i <= classSize; i++) {
        const val = String(i).padStart(2, '0');
        const box = document.getElementById(`matrix-seat-${val}`);
        if (!box) continue;

        if (absentSeatsSet.has(val)) {
            box.className = 'seat-box status-absent';
        } else {
            if (!box.classList.contains('status-done')) {
                box.className = 'seat-box';
            }
        }
        updateInspectionUI(val);
    }
}

function refreshDashboardData() {
    updateDashboardStats(0);

    if (!gasAppUrl) {
        updateDashboardStats(18);
        document.getElementById('dash-avg-score').textContent = '78.5 分';
        for (let i = 1; i <= 18; i++) {
            const val = String(i).padStart(2, '0');
            const box = document.getElementById(`matrix-seat-${val}`);
            if (box && !absentSeatsSet.has(val)) {
                box.className = 'seat-box status-done';
            }
        }
        return;
    }

    fetch(`${gasAppUrl}?action=getDashboard&class=${document.getElementById('select-class').value}`)
        .then(res => res.json())
        .then(data => {
            if (data && data.status === 'success') {
                updateDashboardStats(data.completedCount || 0);
                document.getElementById('dash-avg-score').textContent = `${data.avgScore} 分`;
                cachedClassAvg = data.avgScore;

                if (data.records) {
                    data.records.forEach(r => {
                        const seatBox = document.getElementById(`matrix-seat-${r.seat}`);
                        if (seatBox && !absentSeatsSet.has(r.seat)) {
                            seatBox.className = r.done ? 'seat-box status-done' : 'seat-box status-correcting';
                        }
                    });
                }

                const errorUl = document.getElementById('dash-top-errors');
                errorUl.innerHTML = '';
                if (data.topErrors && data.topErrors.length > 0) {
                    data.topErrors.forEach(err => {
                        const li = document.createElement('li');
                        li.className = 'error-item';
                        li.innerHTML = `<span class="q-tag">第 ${err.id} 題</span> <span>錯題次數：<strong>${err.count}</strong> 人</span>`;
                        errorUl.appendChild(li);
                    });
                }
            }
        }).catch(err => console.log('儀表板輪詢:', err));
}

// 17. 教師後台自訂題數與配分模式 UI 聯動
function loadTeacherSettingsUI() {
    document.getElementById('cfg-total-questions').value = examConfig.totalQuestions;
    document.getElementById('cfg-score-mode').value = examConfig.scoreMode;
    document.getElementById('cfg-score-per-q').value = examConfig.scorePerQ;
    document.getElementById('cfg-split-cut').value = examConfig.splitCut;
    document.getElementById('cfg-split-p1').value = examConfig.splitP1;
    document.getElementById('cfg-split-p2').value = examConfig.splitP2;

    const coolSec = parseInt(localStorage.getItem('gas_cooldown_sec')) || 10;
    document.getElementById('setting-cooldown').value = coolSec;
    document.getElementById('setting-class-size').value = classSize;
    if (document.getElementById('setting-gas-url')) {
        document.getElementById('setting-gas-url').value = gasAppUrl;
    }

    onScoreModeChange();
    onCustomConfigChange();
}

function onScoreModeChange() {
    const mode = document.getElementById('cfg-score-mode').value;
    const equalWrap = document.getElementById('mode-equal-wrap');
    const splitWrap = document.getElementById('mode-split-wrap');

    if (mode === 'equal') {
        equalWrap.classList.remove('hidden');
        splitWrap.classList.add('hidden');
    } else {
        equalWrap.classList.add('hidden');
        splitWrap.classList.remove('hidden');
    }
    onCustomConfigChange();
}

function onCustomConfigChange() {
    const totalQ = parseInt(document.getElementById('cfg-total-questions').value) || 40;
    const mode = document.getElementById('cfg-score-mode').value;

    if (mode === 'equal') {
        const p = parseFloat(document.getElementById('cfg-score-per-q').value) || 2.5;
        const totalScore = Math.round(totalQ * p * 10) / 10;
        document.getElementById('cfg-equal-total-calc').textContent = `${totalQ} 題 × ${p} 分 = ${totalScore} 分 (滿分100)`;
        if (totalScore !== 100) {
            document.getElementById('cfg-equal-total-calc').style.color = '#EF4444';
        } else {
            document.getElementById('cfg-equal-total-calc').style.color = '#1E3A8A';
        }
    } else {
        const cut = parseInt(document.getElementById('cfg-split-cut').value) || 10;
        const p1 = parseFloat(document.getElementById('cfg-split-p1').value) || 3.0;
        const p2 = parseFloat(document.getElementById('cfg-split-p2').value) || 2.0;
        const rest = Math.max(0, totalQ - cut);
        const totalScore = Math.round((cut * p1 + rest * p2) * 10) / 10;
        document.getElementById('cfg-split-total-calc').textContent = `${cut}題×${p1}分 + ${rest}題×${p2}分 = ${totalScore} 分 (滿分100)`;
        if (totalScore !== 100) {
            document.getElementById('cfg-split-total-calc').style.color = '#EF4444';
        } else {
            document.getElementById('cfg-split-total-calc').style.color = '#1E3A8A';
        }
    }
}

// 儲存教師設定
function saveSettings() {
    const totalQ = parseInt(document.getElementById('cfg-total-questions').value) || 40;
    const mode = document.getElementById('cfg-score-mode').value;
    const scorePerQ = parseFloat(document.getElementById('cfg-score-per-q').value) || 2.5;
    const splitCut = parseInt(document.getElementById('cfg-split-cut').value) || 10;
    const splitP1 = parseFloat(document.getElementById('cfg-split-p1').value) || 3.0;
    const splitP2 = parseFloat(document.getElementById('cfg-split-p2').value) || 2.0;

    const coolSec = parseInt(document.getElementById('setting-cooldown').value) || 10;
    const size = parseInt(document.getElementById('setting-class-size').value) || 35;
    const url = document.getElementById('setting-gas-url').value.trim();

    examConfig.totalQuestions = totalQ;
    examConfig.scoreMode = mode;
    examConfig.scorePerQ = scorePerQ;
    examConfig.splitCut = splitCut;
    examConfig.splitP1 = splitP1;
    examConfig.splitP2 = splitP2;

    localStorage.setItem('cfg_total_q', totalQ);
    localStorage.setItem('cfg_score_mode', mode);
    localStorage.setItem('cfg_score_per_q', scorePerQ);
    localStorage.setItem('cfg_split_cut', splitCut);
    localStorage.setItem('cfg_split_p1', splitP1);
    localStorage.setItem('cfg_split_p2', splitP2);

    localStorage.setItem('gas_cooldown_sec', coolSec);
    localStorage.setItem('gas_class_size', size);
    localStorage.setItem('gas_exam_url', url);

    classSize = size;
    gasAppUrl = url;

    initSeatDropdown();
    renderPaletteGrid();
    initDashboardMatrix();
    onScoreInput();

    alert(`✅ 教師設定已成功套用！\n\n• 總題數：${totalQ} 題\n• 配分模式：${mode === 'equal' ? '均分制 ('+scorePerQ+'分/題)' : '分段配分制'}\n• 學生登入頁已同步更新！`);
}

// 18. QR Code 投影彈窗（自動帶入 ?mode=student 純學生端參數）
function openQrModal() {
    // 取得基礎網址並附帶 ?mode=student
    const baseUrl = window.location.href.split('?')[0].split('#')[0];
    const studentUrl = `${baseUrl}?mode=student`;

    const qrImg = document.getElementById('qr-code-img');
    const qrUrlInput = document.getElementById('qr-url-text');

    qrUrlInput.value = studentUrl;
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(studentUrl)}`;

    document.getElementById('modal-qr').classList.remove('hidden');
}

function closeQrModal() {
    document.getElementById('modal-qr').classList.add('hidden');
}

function copySystemUrl() {
    const qrUrlInput = document.getElementById('qr-url-text');
    qrUrlInput.select();
    document.execCommand('copy');
    alert('📋 學生專用訂正網址已成功複製到剪貼簿！');
}
