/**
 * ==========================================================================
 * 🧬 國中生物段考錯題診斷與訂正系統 - Google Apps Script (Code.gs 旗艦版)
 * 傳承與整合「楊光國中生物互動專案」標準試算表風格：
 * 
 * 🌟 核心特色：
 * 1. 自訂選單：【🧬 段考訂正工具】➜【✨ 一鍵美化所有工作表 (高雅科技藍調)】
 * 2. 智慧排版美化：首列凍結、38px 表頭、斑馬紋交替色、欄寬與字型最佳化
 * 3. In-Place Update (就地更新)：同座號覆蓋更新，不產生多列重複洗板
 * 4. 座號 01~35 嚴格補零純文字格式 (@)，自動排序與學校點名冊 100% 吻合
 * 5. 易錯題與班級平均統計 API (支援大螢幕儀表板零延遲輪詢)
 * 6. LockService 腳本鎖保護：全班 35 人同秒交卷排隊寫入，絕不遺漏衝撞
 * ==========================================================================
 */

// 自訂試算表上方選單
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧬 段考訂正工具')
    .addItem('✨ 一鍵美化所有工作表 (套用高雅科技藍調)', 'formatAllSheets')
    .addItem('🔄 重新依座號排序當前工作表', 'sortActiveSheetBySeat')
    .addToUi();
}

/**
 * 接收學生提交訂正紀錄
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 排隊等待最多 30 秒，防止併發衝撞
    lock.waitLock(30000);

    var contents = JSON.parse(e.postData.contents);
    var action = contents.action;

    if (action === "submitRecord") {
      var examId = contents.examId || "11501_2";
      var className = contents.className || "701";
      var sheetName = examId + "_" + className + "班";
      var sheet = getOrCreateExamSheet(sheetName);

      var seat = String(contents.seat || "01").padStart(2, "0");
      var name = contents.name || "";
      var score = contents.score !== undefined ? contents.score : 0;
      var wrongCount = contents.wrongCount !== undefined ? contents.wrongCount : 0;
      var wrongQuestions = (contents.wrongQuestions || []).join(", ");
      var cores = (contents.correctedCores || []).map(function(c) {
        return "[第" + c.id + "題] " + c.core;
      }).join("；\n");

      // 檢查是否已有該座號資料（就地更新防洗板）
      var data = sheet.getDataRange().getValues();
      var foundRow = -1;
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][1]).padStart(2, "0") === seat) {
          foundRow = i + 1;
          break;
        }
      }

      var rowData = [
        new Date(),       // 1. 提交時間
        seat,             // 2. 座號 (01~35)
        name,             // 3. 姓名
        score,            // 4. 段考原始成績
        wrongCount,       // 5. 錯題數
        wrongQuestions,   // 6. 錯題題號
        cores,            // 7. 抄寫核心主句紀錄
        "已完成訂正"       // 8. 訂正狀態
      ];

      if (foundRow > -1) {
        sheet.getRange(foundRow, 1, 1, rowData.length).setValues([rowData]);
      } else {
        sheet.appendRow(rowData);
      }

      // 自動依座號排序 (第 2 欄)
      if (sheet.getLastRow() > 2) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).sort(2);
      }

      // 自動維護儲存格格式與列高
      formatExamSheet(sheet);

      return responseJSON({ status: "success", message: "紀錄已登錄" });
    }
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 儀表板輪詢 API (取得班平均、完成人數、Top 5 易錯題)
 */
function doGet(e) {
  try {
    var params = e ? e.parameter : {};
    var action = params.action || "getDashboard";
    var examId = params.examId || "11501_2";
    var className = params.class || "701";
    var sheetName = examId + "_" + className + "班";

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet || sheet.getLastRow() <= 1) {
      return responseJSON({
        status: "success",
        completedCount: 0,
        avgScore: 0,
        records: [],
        topErrors: []
      });
    }

    var data = sheet.getDataRange().getValues();
    var rows = data.slice(1);
    var totalScore = 0;
    var records = [];
    var questionErrorMap = {};

    rows.forEach(function(r) {
      var seat = String(r[1]).padStart(2, "0");
      var score = parseFloat(r[3]) || 0;
      totalScore += score;
      records.push({ seat: seat, name: r[2], score: score, done: true });

      var wList = String(r[5]).split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      wList.forEach(function(qId) {
        questionErrorMap[qId] = (questionErrorMap[qId] || 0) + 1;
      });
    });

    var avgScore = Math.round((totalScore / rows.length) * 10) / 10;

    var topErrors = Object.keys(questionErrorMap)
      .map(function(k) { return { id: parseInt(k), count: questionErrorMap[k] }; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 5);

    return responseJSON({
      status: "success",
      completedCount: rows.length,
      avgScore: avgScore,
      records: records,
      topErrors: topErrors
    });
  } catch (err) {
    return responseJSON({ status: "error", message: err.toString() });
  }
}

/**
 * 取得或建立班級段考分頁
 */
function getOrCreateExamSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    var headers = ["提交時間", "座號", "姓名", "段考成績", "錯題數", "錯題題號", "抄寫核心主句紀錄", "訂正狀態"];
    sheet.appendRow(headers);
    formatExamSheet(sheet);
  }
  return sheet;
}

/**
 * ✨ 一鍵美化所有工作表 (高雅科技藍調主題)
 */
function formatAllSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var count = 0;

  for (var i = 0; i < sheets.length; i++) {
    formatExamSheet(sheets[i]);
    count++;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(
    "已成功套用科技藍調美化至 " + count + " 個工作表！",
    "✨ 一鍵美化完成",
    4
  );
}

/**
 * 依座號排序當前工作表
 */
function sortActiveSheetBySeat() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).sort(2);
    SpreadsheetApp.getActiveSpreadsheet().toast("已依座號重新排序！", "✅ 排序成功", 3);
  }
}

/**
 * 🌟 核心美化函數：科技藍調風格、斑馬交替紋、精準欄寬
 */
function formatExamSheet(sheet) {
  if (!sheet) return;

  var lastRow = Math.max(sheet.getLastRow(), 2);
  var lastCol = 8;

  // 1. 凍結首列與表頭高度 (38px)
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 38);

  // 2. 表頭文字與顏色 (深海科技藍 #1E3A8A)
  var headerRange = sheet.getRange(1, 1, 1, lastCol);
  headerRange
    .setBackground("#1E3A8A")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setFontSize(11)
    .setVerticalAlignment("middle")
    .setHorizontalAlignment("center");

  // 3. 欄位最佳化寬度
  sheet.setColumnWidth(1, 160); // 1. 提交時間
  sheet.setColumnWidth(2, 65);  // 2. 座號
  sheet.setColumnWidth(3, 95);  // 3. 姓名
  sheet.setColumnWidth(4, 90);  // 4. 段考成績
  sheet.setColumnWidth(5, 80);  // 5. 錯題數
  sheet.setColumnWidth(6, 120); // 6. 錯題題號
  sheet.setColumnWidth(7, 340); // 7. 抄寫核心主句紀錄
  sheet.setColumnWidth(8, 100); // 8. 訂正狀態

  // 4. 資料列排版與垂直置中
  if (lastRow > 1) {
    var dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
    dataRange.setVerticalAlignment("middle").setFontSize(10);

    sheet.getRange(2, 1, lastRow - 1, 1).setHorizontalAlignment("center"); // 時間
    sheet.getRange(2, 2, lastRow - 1, 1).setHorizontalAlignment("center").setNumberFormat("@"); // 座號補零純文字
    sheet.getRange(2, 3, lastRow - 1, 1).setHorizontalAlignment("center").setFontWeight("bold"); // 姓名
    sheet.getRange(2, 4, lastRow - 1, 1).setHorizontalAlignment("center").setFontWeight("bold"); // 成績
    sheet.getRange(2, 5, lastRow - 1, 1).setHorizontalAlignment("center"); // 錯題數
    sheet.getRange(2, 6, lastRow - 1, 1).setHorizontalAlignment("center"); // 錯題題號
    sheet.getRange(2, 7, lastRow - 1, 1).setHorizontalAlignment("left").setWrap(true);   // 主句自動換行
    sheet.getRange(2, 8, lastRow - 1, 1).setHorizontalAlignment("center").setFontWeight("bold").setFontColor("#059669"); // 狀態綠色

    // 設定資料列高 (給予主句充足空間)
    for (var r = 2; r <= Math.min(lastRow, 50); r++) {
      sheet.setRowHeight(r, 36);
    }
  }

  // 5. 套用斑馬條紋交替色彩 (白底 / 冰川淺藍 #F0F9FF)
  try {
    var bandings = sheet.getBandings();
    for (var b = 0; b < bandings.length; b++) {
      bandings[b].remove();
    }
    var fullRange = sheet.getRange(1, 1, Math.max(lastRow, 40), lastCol);
    fullRange.applyRowBanding()
      .setHeaderRowColor("#1E3A8A")
      .setFirstRowColor("#FFFFFF")
      .setSecondRowColor("#F0F9FF");
  } catch (e) {}
}

function responseJSON(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
