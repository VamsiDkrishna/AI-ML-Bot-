/*******************************************************
 * VExa Attendance Bot
 * VX Software Solutions
 *
 * One complete production script for:
 * - Slack Logged in / Logged out attendance
 * - Shift locked from login
 * - Night-shift after-midnight logout handling
 * - Natural-language leave requests using OpenAI
 * - Multiple leave dates with one request ID
 * - Informed To vs Approval Requested From vs Approved By
 * - Leave approval DMs with Approve / Reject buttons
 * - 7:00 AM morning present report
 * - 3:45 PM morning final report
 * - 4:00 PM evening present report
 * - 12:30 AM evening final report
 * - Present / Absent names
 * - (Not Logged Out) / (Missing Login)
 * - Employee DM queries: present / my attendance / my leave
 * - @VExa Attendance Bot mentions
 * - Attendance exclusion via Active / Attendance Tracking only
 * - Automatic employee / approver synchronization
 * - Duplicate Slack event protection
 * - Automatic Leaves / Attendance / Corrections / Approvers sheets
 * - Automatic reports to #ai-ml-team
 *
 * IMPORTANT:
 * 1. Keep the Script Properties names exactly:
 *      SLACK_BOT_TOKEN
 *      OPENAI_API_KEY
 * 2. Set the Apps Script project timezone to Asia/Kolkata.
 * 3. Slack Events Request URL and Interactivity Request URL
 *    should both point to the deployed Web App /exec URL.
 *******************************************************/


/***********************
 * CONFIGURATION
 ***********************/

const ATTENDANCE_SHEET = 'Attendance';
const EMPLOYEE_SHEET = 'Employees';
const LEAVE_SHEET = 'Leaves';
const CORRECTION_SHEET = 'Corrections';
const APPROVER_SHEET = 'Approvers';

const CHANNEL_ID = 'C0BT2AALUP8';
const TIMEZONE = 'Asia/Kolkata';
const OPENAI_MODEL = 'gpt-5.6-luna';

const MORNING_SHIFT = '6 AM - 3 PM';
const EVENING_SHIFT = '3 PM - 12 AM';

const APPROVED_APPROVER_NAMES = [
  'siva kumar',
  'vamsi krishna',
  'pradeep reddy',
  'deekshitha karanam',
  'maneesha guggilla',
  'madhav reddy k v'
];

const EXCLUDED_ATTENDANCE_USER_IDS = [
  'U0C499FUN03',
  'U0C485T84P7'
];

const MESSAGE_CACHE_SECONDS = 21600;
const REPORT_CACHE_SECONDS = 86400;
const REPORT_WINDOW_MINUTES = 60;


/***********************
 * MAIN SLACK WEBHOOK
 ***********************/

function doPost(e) {

  // Slack Block Kit button action.
  // Queue the action and return immediately so Slack does not time out.
  if (e && e.parameter && e.parameter.payload) {
    try {
      const payload = JSON.parse(e.parameter.payload);

      const queueKey =
        'SLACK_INTERACTION_' + Utilities.getUuid();

      const queueLock = LockService.getScriptLock();
      queueLock.waitLock(5000);
      try {
        PropertiesService
          .getScriptProperties()
          .setProperty(queueKey, JSON.stringify(payload));
      } finally {
        queueLock.releaseLock();
      }

      return ContentService
        .createTextOutput('OK')
        .setMimeType(ContentService.MimeType.TEXT);

    } catch (error) {
      console.error(
        'Slack interaction queue error: ' + error.message
      );

      return ContentService
        .createTextOutput('OK')
        .setMimeType(ContentService.MimeType.TEXT);
    }
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: true });
    }

    const data = JSON.parse(e.postData.contents);

    if (data.type === 'url_verification') {
      return ContentService
        .createTextOutput(data.challenge)
        .setMimeType(ContentService.MimeType.TEXT);
    }

    if (data.type !== 'event_callback') {
      return jsonResponse({ ok: true });
    }

    const event = data.event;

    if (!event) {
      return jsonResponse({ ok: true });
    }

    if (
      event.bot_id ||
      event.subtype === 'bot_message' ||
      event.subtype === 'message_changed' ||
      event.subtype === 'message_deleted'
    ) {
      return jsonResponse({ ok: true });
    }

    const eventId = data.event_id;

    if (eventId && wasProcessed(eventId)) {
      return jsonResponse({
        ok: true,
        duplicate: true
      });
    }

    // Do not hold a global script lock while calling Slack / OpenAI.
    // A global lock can cause concurrent employee attendance events to be
    // dropped during busy login/logout periods. Attendance writes are
    // idempotent by employee/date, and duplicate Slack events are cached.
    let processed = false;

    if (event.type === 'app_mention') {
      const text = cleanSlackMentions(event.text || '');

      processed = handleUserMessage(
        event.user,
        text,
        event.channel,
        event.ts,
        true
      );
    }

    else if (event.type === 'message') {
      const channel = event.channel;
      const text = (event.text || '').trim();

      const isDM =
        channel && channel.charAt(0) === 'D';

      const isAttendanceChannel =
        channel === CHANNEL_ID;

      if (isDM || isAttendanceChannel) {
        processed = handleUserMessage(
          event.user,
          text,
          channel,
          event.ts,
          false
        );
      }
    }

    if (eventId && processed) {
      markProcessed(eventId);
    }

    return jsonResponse({ ok: true });

  } catch (error) {
    console.error(
      'doPost error: ' + error.message
    );

    // Always acknowledge Slack.
    return jsonResponse({
      ok: true
    });
  }
}


/***********************
 * HANDLE USER MESSAGE
 ***********************/

function handleUserMessage(
  userId,
  text,
  channelId,
  eventTs,
  isMention
) {

  if (!userId || !text) {
    return false;
  }

  const normalized = normalizeMessage(text);

  const messageKey =
    'MSG_' +
    Utilities.base64EncodeWebSafe(
      userId + '|' + eventTs + '|' + normalized
    ).substring(0, 180);

  const messageCache = CacheService.getScriptCache();

  if (messageCache.get(messageKey)) {
    return false;
  }

  let processed = false;

  // Personal attendance query.
  if (isAttendanceQuery(normalized)) {
    if (!isAttendanceEmployee(userId)) {
      sendSlackMessage(
        channelId,
        'ℹ️ Attendance tracking is not enabled for your profile.'
      );
      processed = true;
    } else {
      const reply = buildPersonalAttendanceReply(userId);

      if (isMention && channelId === CHANNEL_ID) {
        sendSlackMessage(
          channelId,
          'Please DM me `present` or `my attendance` for your personal attendance details.',
          eventTs
        );
      } else {
        sendSlackMessage(channelId, reply);
      }

      processed = true;
    }
  }

  // Personal leave query.
  else if (isLeaveQuery(normalized)) {
    sendSlackMessage(
      channelId,
      buildPersonalLeaveReply(userId)
    );

    processed = true;
  }

  // Login.
  else if (isLoginMessage(normalized)) {
    // Management / unassigned users are excluded from attendance,
    // but their leave requests remain enabled.
    if (isAttendanceEmployee(userId)) {
      recordAttendance(userId, 'LOGIN', eventTs, channelId);
    }
    processed = true;
  }

  // Logout.
  else if (isLogoutMessage(normalized)) {
    if (isAttendanceEmployee(userId)) {
      recordAttendance(userId, 'LOGOUT', eventTs, channelId);
    }
    processed = true;
  }

  // Attendance correction.
  else if (looksLikeCorrection(normalized)) {
    if (isAttendanceEmployee(userId)) {
      recordCorrectionRequest(userId, text, eventTs);
      sendSlackMessage(
        channelId,
        '📝 Your attendance correction request has been recorded as `Pending Approval`. Your attendance will not be changed automatically.'
      );
    } else {
      sendSlackMessage(
        channelId,
        'ℹ️ Attendance tracking is not enabled for your profile.'
      );
    }
    processed = true;
  }

  // Natural-language leave request.
  else if (looksLikeLeaveRequest(normalized)) {

    let leave;
    try {
      leave = extractLeaveWithAI(text, userId, eventTs);
    } catch (error) {
      console.error('Leave extraction error: ' + error.message);
      sendSlackMessage(
        channelId,
        '⚠️ I could not process your leave request right now. Please try again in a few minutes. If the problem continues, contact HR/admin.'
      );
      return true;
    }

    if (!leave || !leave.is_leave_request) {
      sendSlackMessage(
        channelId,
        'I could not confidently identify the leave details. Please mention the leave date and reason clearly.'
      );

      processed = true;
    } else if (
      !leave.leave_dates ||
      !leave.leave_dates.length
    ) {
      sendSlackMessage(
        channelId,
        'Please mention the leave date or dates clearly so I can record the request.'
      );

      processed = true;
    } else {
      const rowsCreated = recordLeave(
        userId,
        eventTs,
        leave
      );

      sendSlackMessage(
        channelId,
        buildLeaveConfirmation(leave, rowsCreated)
      );

      processed = true;
    }
  }

  else {
    // No recognized command. Do not mark the event processed.
    return false;
  }

  if (processed) {
    messageCache.put(
      messageKey,
      '1',
      MESSAGE_CACHE_SECONDS
    );
  }

  return processed;
}


/***********************
 * LOGIN / LOGOUT DETECTION
 ***********************/

function isLoginMessage(text) {
  return [
    'logged in',
    'login',
    'loggedin',
    'logged-in'
  ].indexOf(text) !== -1;
}

function isLogoutMessage(text) {
  return [
    'logged out',
    'logout',
    'loggedout',
    'logged-out'
  ].indexOf(text) !== -1;
}


function getEmployeeDisplayName(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(EMPLOYEE_SHEET);

  if (sheet) {
    const values = sheet.getDataRange().getValues();

    for (let i = 1; i < values.length; i++) {
      const id = String(values[i][1] || '').trim();
      if (id === String(userId).trim()) {
        const name = String(values[i][0] || '').trim();
        if (name) {
          return name;
        }
      }
    }
  }

  return getSlackUserName(userId);
}

function sendAttendanceConfirmation(channel, text) {
  try {
    sendSlackMessage(channel || CHANNEL_ID, text);
  } catch (error) {
    console.error('Attendance confirmation error: ' + error.message);
  }
}


/***********************
 * ATTENDANCE RECORDING
 ***********************/

function recordAttendance(userId, type, slackTs, replyChannel) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    return recordAttendanceUnlocked(userId, type, slackTs, replyChannel);
  } finally {
    try { lock.releaseLock(); } catch (error) {
      console.error('Attendance lock release error: ' + error.message);
    }
  }
}

function recordAttendanceUnlocked(userId, type, slackTs, replyChannel) {

  const sheet = getOrCreateAttendanceSheet();
  const employeeName = getEmployeeDisplayName(userId);
  const timestamp = slackTsToDate(slackTs);
  const workDate = getAttendanceWorkDate(timestamp, type);
  const dateString = formatDate(workDate);

  // Assigned Shift in the Employees sheet (Column C) is the
  // single source of truth. Never infer a shift from Slack login time.
  const shift = getEmployeeAssignedShift(userId);

  if (!shift) {
    sendAttendanceConfirmation(
      replyChannel || CHANNEL_ID,
      '⚠️ Your attendance could not be recorded because no Assigned Shift is configured in the Employees sheet. Please ask the admin to set your shift.'
    );
    return;
  }

  /***********************
   * LOGIN
   ***********************/

  if (type === 'LOGIN') {

    const existing = findAttendanceRow(
      sheet,
      dateString,
      userId
    );

    if (existing) {

      if (existing.login) {
        sendAttendanceConfirmation(
          replyChannel || CHANNEL_ID,
          'ℹ️ Your login is already recorded for ' + dateString + '.'
        );
        return;
      }

      // Existing logout-only row: fill login using the employee's
      // assigned shift from the Employees sheet.
      sheet.getRange(existing.row, 5).setValue(timestamp);
      sheet.getRange(existing.row, 4).setValue(shift);
      sheet.getRange(existing.row, 8).setValue('Logged In');
      formatAttendanceSheet(sheet);

      sendAttendanceConfirmation(
        replyChannel || CHANNEL_ID,
        '✅ Logged in recorded at ' +
          formatDateTime(timestamp) +
          '\nShift: ' +
          (existing.shift || shift)
      );
      return;
    }

    // Shift is locked here. Logout never recalculates it.
    sheet.appendRow([
      workDate,
      employeeName,
      userId,
      shift,
      timestamp,
      '',
      '',
      'Logged In'
    ]);

    formatAttendanceSheet(sheet);

    sendAttendanceConfirmation(
      replyChannel || CHANNEL_ID,
      '✅ Logged in recorded at ' +
        formatDateTime(timestamp) +
        '\nShift: ' + shift
    );

    return;
  }

  /***********************
   * LOGOUT
   ***********************/

  if (type === 'LOGOUT') {

    const existing = findAttendanceRow(
      sheet,
      dateString,
      userId
    );

    if (!existing) {
      // Logout without login: do not invent a login time.
      // The shift still comes from Employees!C.
      sheet.appendRow([
        workDate,
        employeeName,
        userId,
        shift,
        '',
        timestamp,
        '',
        'Missing Login'
      ]);

      formatAttendanceSheet(sheet);

      sendAttendanceConfirmation(
        replyChannel || CHANNEL_ID,
        '⚠️ Your logout was recorded, but no login was found for ' +
          dateString +
          '. Status: `Missing Login`.'
      );

      return;
    }

    // IMPORTANT: never change existing.shift on logout.
    sheet.getRange(existing.row, 6).setValue(timestamp);

    if (existing.logout) {
      sendAttendanceConfirmation(
        replyChannel || CHANNEL_ID,
        'ℹ️ Your logout is already recorded for ' + dateString + '.'
      );
      return;
    }

    if (existing.login) {
      const totalHours = calculateHours(
        existing.login,
        timestamp
      );

      sheet.getRange(existing.row, 7).setValue(totalHours);
      sheet.getRange(existing.row, 8).setValue('Completed');

    } else {
      sheet.getRange(existing.row, 8).setValue('Missing Login');
    }

    formatAttendanceSheet(sheet);

    sendAttendanceConfirmation(
      replyChannel || CHANNEL_ID,
      '✅ Logged out recorded at ' +
        formatDateTime(timestamp) +
        '\nShift: ' +
        (existing.shift || shift || '')
    );
  }
}




/***********************
 * ATTENDANCE DATE / SHIFT
 ***********************/

function getAttendanceWorkDate(date, type) {
  const hour = Number(
    Utilities.formatDate(date, TIMEZONE, 'H')
  );

  const result = new Date(date);

  // A night-shift logout after midnight belongs to the previous work date.
  if (type === 'LOGOUT' && hour < 6) {
    result.setDate(result.getDate() - 1);
  }

  return result;
}

function normalizeShift(value) {
  return String(value || '')
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getShiftFromLoginTime(date) {
  // Deprecated: shift must come from Employees!C.
  // Kept only for backward compatibility with old test calls.
  return '';
}

function getEmployeeAssignedShift(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(EMPLOYEE_SHEET);

  if (!sheet) {
    return '';
  }

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][1] || '').trim();

    if (id === String(userId).trim()) {
      return normalizeShift(values[i][2] || '');
    }
  }

  return '';
}

function isAttendanceEmployee(userId) {
  const normalizedUserId = String(userId || '').trim();

  if (!normalizedUserId) {
    return false;
  }

  // Only these two users are explicitly excluded from attendance.
  if (EXCLUDED_ATTENDANCE_USER_IDS.indexOf(normalizedUserId) !== -1) {
    return false;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(EMPLOYEE_SHEET);

  if (!sheet) {
    return false;
  }

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][1] || '').trim();

    if (id !== normalizedUserId) {
      continue;
    }

    const active = String(
      values[i][3] === '' ? 'YES' : values[i][3]
    ).trim().toUpperCase();

    const tracking = String(
      values[i][4] === '' ? 'YES' : values[i][4]
    ).trim().toUpperCase();

    // Assigned Shift may be blank. In that case, login time determines the
    // shift and the chosen shift is then locked on the attendance row.
    return active === 'YES' && tracking === 'YES';
  }

  return false;
}


/***********************
 * ATTENDANCE LOOKUP / HOURS
 ***********************/

function findAttendanceRow(sheet, dateString, userId) {
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const rowDate = formatDate(values[i][0]);
    const rowUserId = String(values[i][2] || '').trim();

    if (
      rowDate === dateString &&
      rowUserId === String(userId).trim()
    ) {
      return {
        row: i + 1,
        employee: values[i][1],
        userId: rowUserId,
        shift: String(values[i][3] || '').trim(),
        login: values[i][4],
        logout: values[i][5],
        total: values[i][6],
        status: values[i][7]
      };
    }
  }

  return null;
}

function calculateHours(login, logout) {
  const start = new Date(login).getTime();
  const end = new Date(logout).getTime();

  if (
    isNaN(start) ||
    isNaN(end) ||
    end < start
  ) {
    return '';
  }

  const totalMinutes = Math.round(
    (end - start) / 60000
  );

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours + 'h ' + minutes + 'm';
}


/***********************
 * LEAVE DETECTION
 ***********************/

function looksLikeLeaveRequest(text) {
  const keywords = [
    'leave',
    'holiday',
    'day off',
    'time off',
    'absence',
    'absent',
    'permission',
    'take off',
    'taking off',
    'need off',
    'need a day',
    'need to be away',
    'will be away',
    'be away from work',
    'not available',
    'not be available',
    "won't be available",
    'will not be available',
    "won't be able to",
    'will not be able to',
    'cannot come',
    "can't come",
    'not able to come',
    'unable to come',
    'not coming to office',
    "won't come to office",
    'will not come to office',
    'family function',
    'family event',
    'personal work',
    'personal commitment',
    'appointment',
    'engagement',
    'ceremony',
    'rituals',
    'vacation'
  ];

  return keywords.some(function(word) {
    return text.indexOf(word) !== -1;
  });
}

function isLeaveQuery(text) {
  return [
    'my leave',
    'my leaves',
    'leave status',
    'leave details',
    'my leave status'
  ].some(function(word) {
    return text.indexOf(word) !== -1;
  });
}


/***********************
 * OPENAI LEAVE EXTRACTION
 ***********************/

function extractLeaveWithAI(message, userId, eventTs) {

  const apiKey = PropertiesService
    .getScriptProperties()
    .getProperty('OPENAI_API_KEY');

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing.');
  }

  const now = new Date();
  const currentDate = formatDate(now);
  const currentDay = Utilities.formatDate(
    now,
    TIMEZONE,
    'EEEE'
  );

  const userName = getSlackUserName(userId);

  const prompt = `
You are VExa Attendance Bot for an Indian company.

Extract leave information from an employee's natural-language message.

Current India date: ${currentDate}
Current India weekday: ${currentDay}
Employee name: ${userName}
Slack User ID: ${userId}

Rules:
1. Understand natural language leave requests.
2. "today" means today's calendar date.
3. "tomorrow" means the next calendar date.
4. "day after tomorrow" means two calendar days from today.
5. If the employee says only "Monday", resolve it to the upcoming Monday.
6. "Monday and Tuesday" means both dates.
7. "from Monday to Wednesday" means every date in the range.
8. If a date is unclear, do NOT invent it.
9. Extract the reason when stated.
10. "Informed To" is populated only when the employee says they informed, told, intimated, notified, etc.
11. Being informed is NOT approval.
12. "I informed Deekshitha" => informed_to = Deekshitha; approved_by = "".
13. "I requested approval from Vamsi sir" => approval_requested_from = Vamsi sir; approved_by = "".
14. "Please approve my leave" is a request, not approval.
15. "Kindly approve my leave" is a request, not approval.
16. Only explicit approval statements such as "approved by Pradeep", "Pradeep approved my leave", or equivalent should populate approved_by.
17. If there is no explicit approval, status = "Pending Approval".
18. If there is explicit approval, status = "Approved".
19. Never invent an approver.
20. Extract an approval_requested_from field separately from approved_by.
21. Return all leave dates as YYYY-MM-DD.
22. Do not add dates that were not requested.
23. Duration should describe the requested leave duration.

Employee message:
${message}
`;

  const payload = {
    model: OPENAI_MODEL,
    input: prompt,
    text: {
      format: {
        type: 'json_schema',
        name: 'leave_extraction',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            is_leave_request: {
              type: 'boolean'
            },
            leave_dates: {
              type: 'array',
              items: {
                type: 'string'
              }
            },
            duration: {
              type: 'string'
            },
            reason: {
              type: 'string'
            },
            informed_to: {
              type: 'string'
            },
            approval_requested_from: {
              type: 'string'
            },
            approved_by: {
              type: 'string'
            },
            status: {
              type: 'string',
              enum: [
                'Approved',
                'Pending Approval'
              ]
            }
          },
          required: [
            'is_leave_request',
            'leave_dates',
            'duration',
            'reason',
            'informed_to',
            'approval_requested_from',
            'approved_by',
            'status'
          ],
          additionalProperties: false
        }
      }
    }
  };

  const response = UrlFetchApp.fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode !== 200) {
    throw new Error(
      'OpenAI error ' + statusCode + ': ' + body
    );
  }

  const data = JSON.parse(body);

  let outputText = data.output_text || '';

  if (!outputText) {
    outputText = extractResponseText(data);
  }

  if (!outputText) {
    throw new Error(
      'OpenAI returned no structured output.'
    );
  }

  const leave = JSON.parse(outputText);

  // Approval is ALWAYS a real Slack action.
  // Never treat employee text as an actual approval.
  leave.approved_by = '';
  leave.status = 'Pending Approval';

  if (!leave.approval_requested_from) {
    leave.approval_requested_from = '';
  }

  if (!leave.informed_to) {
    leave.informed_to = '';
  }

  return leave;
}

function extractResponseText(data) {
  try {
    if (!data || !data.output) {
      return '';
    }

    for (let i = 0; i < data.output.length; i++) {
      const item = data.output[i];

      if (!item.content || !Array.isArray(item.content)) {
        continue;
      }

      for (let j = 0; j < item.content.length; j++) {
        if (item.content[j].text) {
          return item.content[j].text;
        }
      }
    }
  } catch (error) {
    console.error('extractResponseText error: ' + error.message);
  }

  return '';
}


/***********************
 * RECORD LEAVE
 ***********************/

function recordLeave(userId, eventTs, leave) {

  const sheet = getOrCreateLeaveSheet();
  const employeeName = getSlackUserName(userId);
  const submittedAt = slackTsToDate(eventTs);

  if (
    !leave ||
    !leave.leave_dates ||
    leave.leave_dates.length === 0
  ) {
    return 0;
  }

  const requestId =
    'LR-' +
    Utilities.formatDate(
      submittedAt,
      TIMEZONE,
      'yyyyMMdd-HHmmss'
    ) +
    '-' +
    String(userId).replace(/[^A-Za-z0-9]/g, '');

  let rowsCreated = 0;

  leave.leave_dates.forEach(function(dateString) {
    const date = parseISODate(dateString);

    if (!date) {
      return;
    }

    const status = 'Pending Approval';

    sheet.appendRow([
      requestId,
      date,
      employeeName,
      userId,
      leave.reason || '',
      leave.informed_to || '',
      leave.approval_requested_from || '',
      leave.approved_by || '',
      submittedAt,
      status
    ]);

    rowsCreated++;
  });

  formatLeaveSheet(sheet);

  // Only explicit approval requests trigger Approve / Reject buttons.
  // The leave rows must remain recorded even if the Slack approval DM fails.
  if (
    rowsCreated > 0 &&
    leave.approval_requested_from
  ) {
    try {
      sendLeaveApprovalRequest(
        requestId,
        userId,
        employeeName,
        leave
      );
    } catch (error) {
      console.error(
        'Leave approval notification error: ' + error.message
      );

      try {
        sendSlackMessageToUser(
          userId,
          '⚠️ Your leave request was recorded, but I could not send the approval notification to the approver. Please contact HR/admin and share Request ID: ' + requestId
        );
      } catch (notifyError) {
        console.error(
          'Leave failure notification error: ' + notifyError.message
        );
      }
    }
  }

  return rowsCreated;
}

function buildLeaveConfirmation(leave, rowsCreated) {
  let text =
    '📝 *Leave request recorded*\n\n' +
    '📅 *Date(s):* ' +
    (leave.leave_dates || []).join(', ') +
    '\n';

  if (leave.duration) {
    text += '*Duration:* ' + leave.duration + '\n';
  }

  if (leave.reason) {
    text += '*Reason:* ' + leave.reason + '\n';
  }

  if (leave.informed_to) {
    text += '*Informed To:* ' + leave.informed_to + '\n';
  }

  if (leave.approval_requested_from) {
    text +=
      '*Approval Requested From:* ' +
      leave.approval_requested_from +
      '\n';
  }

  if (leave.approved_by) {
    text +=
      '*Approved By:* ' +
      leave.approved_by +
      '\n';
  }

  text +=
    '*Status:* ' +
    'Pending Approval' +
    '\n' +
    '*Rows Created:* ' +
    rowsCreated;

  return text;
}


/***********************
 * LEAVE APPROVAL REQUEST
 ***********************/

function sendLeaveApprovalRequest(
  requestId,
  employeeSlackId,
  employeeName,
  leave
) {

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(APPROVER_SHEET);

  if (!sheet) {
    throw new Error('Approvers sheet not found.');
  }

  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    throw new Error('No approvers are configured.');
  }

  const headers = data[0];

  const employeeCol = headers.indexOf('Employee');
  const slackIdCol = headers.indexOf('Slack User ID');
  const designationCol = headers.indexOf('Designation');
  const canApproveCol = headers.indexOf('Can Approve Leave');

  if (
    employeeCol === -1 ||
    slackIdCol === -1 ||
    canApproveCol === -1
  ) {
    throw new Error('Approvers sheet columns are missing.');
  }

  const requestedApprover = String(
    leave.approval_requested_from || ''
  ).trim();

  if (!requestedApprover) {
    return;
  }

  const normalizedRequested =
    normalizeApproverName(requestedApprover);

  let approver = null;

  for (let i = 1; i < data.length; i++) {
    const name = String(
      data[i][employeeCol] || ''
    ).trim();

    const slackUserId = String(
      data[i][slackIdCol] || ''
    ).trim();

    const canApprove = String(
      data[i][canApproveCol] || ''
    ).trim().toUpperCase();

    if (
      !name ||
      !slackUserId ||
      canApprove !== 'YES'
    ) {
      continue;
    }

    const normalizedName =
      normalizeApproverName(name);

    if (approverNameMatches(
      normalizedName,
      normalizedRequested
    )) {
      approver = {
        name: name,
        slackUserId: slackUserId,
        designation:
          designationCol !== -1
            ? String(data[i][designationCol] || '').trim()
            : ''
      };
      break;
    }
  }

  if (!approver) {
    sendSlackMessageToUser(
      employeeSlackId,
      '⚠️ I could not find an authorized leave approver for "' +
        requestedApprover +
        '". Please mention one of the authorized approvers.'
    );
    return;
  }

  const dates =
    (leave.leave_dates || []).join(', ');

  let message =
    '📝 *Leave Approval Request*\n\n' +
    '*Employee:* ' + employeeName + '\n' +
    '*Leave Date(s):* ' + dates + '\n';

  if (leave.duration) {
    message += '*Duration:* ' + leave.duration + '\n';
  }

  if (leave.reason) {
    message += '*Reason:* ' + leave.reason + '\n';
  }

  if (leave.informed_to) {
    message += '*Informed To:* ' + leave.informed_to + '\n';
  }

  message +=
    '*Request ID:* ' + requestId + '\n\n' +
    'Please review this leave request.';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📝 *Leave Approval Request*'
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Employee:* ' + employeeName +
          '\n*Leave Date(s):* ' + dates +
          (leave.duration
            ? '\n*Duration:* ' + leave.duration
            : '') +
          (leave.reason
            ? '\n*Reason:* ' + leave.reason
            : '') +
          (leave.informed_to
            ? '\n*Informed To:* ' + leave.informed_to
            : '') +
          '\n*Request ID:* ' + requestId
      }
    },
    {
      type: 'divider'
    },
    {
      type: 'actions',
      block_id: 'leave_approval_actions_' + requestId,
      elements: [
        {
          type: 'button',
          action_id: 'approve_leave',
          text: {
            type: 'plain_text',
            text: 'Approve'
          },
          style: 'primary',
          value: requestId,
          confirm: {
            title: {
              type: 'plain_text',
              text: 'Approve Leave?'
            },
            text: {
              type: 'mrkdwn',
              text: 'Are you sure you want to approve this leave request?'
            },
            confirm: {
              type: 'plain_text',
              text: 'Approve'
            },
            deny: {
              type: 'plain_text',
              text: 'Cancel'
            }
          }
        },
        {
          type: 'button',
          action_id: 'reject_leave',
          text: {
            type: 'plain_text',
            text: 'Reject'
          },
          style: 'danger',
          value: requestId,
          confirm: {
            title: {
              type: 'plain_text',
              text: 'Reject Leave?'
            },
            text: {
              type: 'mrkdwn',
              text: 'Are you sure you want to reject this leave request?'
            },
            confirm: {
              type: 'plain_text',
              text: 'Reject'
            },
            deny: {
              type: 'plain_text',
              text: 'Cancel'
            }
          }
        }
      ]
    }
  ];

  const dmChannelId = openDirectMessage(
    approver.slackUserId
  );

  const response = UrlFetchApp.fetch(
    'https://slack.com/api/chat.postMessage',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization:
          'Bearer ' + getSlackBotToken()
      },
      payload: JSON.stringify({
        channel: dmChannelId,
        text: message,
        blocks: blocks
      }),
      muteHttpExceptions: true
    }
  );

  const result = JSON.parse(
    response.getContentText()
  );

  if (!result.ok) {
    throw new Error(
      'Could not send approval DM: ' + result.error
    );
  }
}

function normalizeApproverName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(mam|madam|sir|mr|mrs|ms|miss)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function approverNameMatches(name, requested) {
  if (!name || !requested) {
    return false;
  }

  if (name === requested) {
    return true;
  }

  if (
    name.indexOf(requested) !== -1 ||
    requested.indexOf(name) !== -1
  ) {
    return true;
  }

  // First-name matching supports "Vamsi sir" / "Pradeep sir".
  const firstNameA = name.match(/^[a-z]+/);
  const firstNameB = requested.match(/^[a-z]+/);

  return !!(
    firstNameA &&
    firstNameB &&
    firstNameA[0] === firstNameB[0]
  );
}


/***********************
 * PROCESS QUEUED SLACK INTERACTIONS
 ***********************/

function processQueuedSlackInteractions() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.warn('Another execution is processing Slack interactions.');
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const all = props.getProperties();
    Object.keys(all).forEach(function(key) {
      if (key.indexOf('SLACK_INTERACTION_') !== 0) return;
      try {
        const payload = JSON.parse(all[key]);
        handleSlackInteraction(payload);
        props.deleteProperty(key);
      } catch (error) {
        console.error('Queued Slack interaction error: ' + error.message);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function handleSlackInteraction(payload) {
  if (
    !payload ||
    payload.type !== 'block_actions'
  ) {
    return;
  }

  const action =
    payload.actions && payload.actions[0];

  if (!action) {
    return;
  }

  const actionId = action.action_id;
  const requestId = action.value;
  const approverId =
    payload.user && payload.user.id;

  if (!requestId || !approverId) {
    return;
  }

  if (
    actionId !== 'approve_leave' &&
    actionId !== 'reject_leave'
  ) {
    return;
  }

  if (!isAuthorizedLeaveApprover(approverId)) {
    sendSlackMessageToUser(
      approverId,
      '❌ You are not authorized to approve or reject leave requests.'
    );
    return;
  }

  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(LEAVE_SHEET);

  if (!sheet) {
    throw new Error('Leaves sheet not found.');
  }

  const data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return;
  }

  const headers = data[0];

  const requestIdCol = headers.indexOf('Leave Request ID');
  const approvedByCol = headers.indexOf('Approved By');
  const statusCol = headers.indexOf('Status');
  const employeeIdCol = headers.indexOf('Slack User ID');

  if (
    requestIdCol === -1 ||
    approvedByCol === -1 ||
    statusCol === -1 ||
    employeeIdCol === -1
  ) {
    throw new Error(
      'Required Leaves columns are missing.'
    );
  }

  const newStatus =
    actionId === 'approve_leave'
      ? 'Approved'
      : 'Rejected';

  const approverName = getSlackUserName(approverId);
  const employeeIds = {};
  let requestFound = false;
  let alreadyProcessed = false;

  for (let i = 1; i < data.length; i++) {
    if (
      String(data[i][requestIdCol] || '') !==
      String(requestId)
    ) {
      continue;
    }

    requestFound = true;

    const currentStatus = String(
      data[i][statusCol] || ''
    ).trim();

    if (
      currentStatus === 'Approved' ||
      currentStatus === 'Rejected'
    ) {
      alreadyProcessed = true;
      continue;
    }

    sheet.getRange(
      i + 1,
      approvedByCol + 1
    ).setValue(approverName);

    sheet.getRange(
      i + 1,
      statusCol + 1
    ).setValue(newStatus);

    const employeeId = String(
      data[i][employeeIdCol] || ''
    ).trim();

    if (employeeId) {
      employeeIds[employeeId] = true;
    }
  }

  if (!requestFound) {
    sendSlackMessageToUser(
      approverId,
      '⚠️ Leave request not found.'
    );
    return;
  }

  if (alreadyProcessed) {
    sendSlackMessageToUser(
      approverId,
      'ℹ️ This leave request has already been processed.'
    );
    return;
  }

  // Notify the employee once, even for multi-day leave.
  Object.keys(employeeIds).forEach(function(employeeId) {
    const message =
      newStatus === 'Approved'
        ? '✅ Your leave request has been approved.\nApproved by: ' +
          approverName
        : '❌ Your leave request has been rejected.\nReviewed by: ' +
          approverName;

    sendSlackMessageToUser(employeeId, message);
  });

  // Update the approver's DM message to remove the buttons.
  updateApprovalMessage(payload, newStatus, approverName);
}

function isAuthorizedLeaveApprover(userId) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(APPROVER_SHEET);

  if (!sheet) {
    return false;
  }

  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return false;
  }

  const headers = values[0];
  const userIdCol = headers.indexOf('Slack User ID');
  const canApproveCol = headers.indexOf('Can Approve Leave');

  if (
    userIdCol === -1 ||
    canApproveCol === -1
  ) {
    return false;
  }

  for (let i = 1; i < values.length; i++) {
    const id = String(
      values[i][userIdCol] || ''
    ).trim();

    const canApprove = String(
      values[i][canApproveCol] || ''
    ).trim().toUpperCase();

    if (
      id === String(userId).trim() &&
      canApprove === 'YES'
    ) {
      return true;
    }
  }

  return false;
}

function updateApprovalMessage(payload, status, approverName) {
  try {
    const channelId =
      payload.channel && payload.channel.id
        ? payload.channel.id
        : payload.container && payload.container.channel_id
          ? payload.container.channel_id
          : '';

    const messageTs =
      payload.message && payload.message.ts
        ? payload.message.ts
        : payload.container && payload.container.message_ts
          ? payload.container.message_ts
          : '';

    if (!channelId || !messageTs) {
      return;
    }

    const text =
      status === 'Approved'
        ? '✅ Leave approved by ' + approverName
        : '❌ Leave rejected by ' + approverName;

    UrlFetchApp.fetch(
      'https://slack.com/api/chat.update',
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          Authorization:
            'Bearer ' + getSlackBotToken()
        },
        payload: JSON.stringify({
          channel: channelId,
          ts: messageTs,
          text: text,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: text
              }
            }
          ]
        }),
        muteHttpExceptions: true
      }
    );
  } catch (error) {
    console.error(
      'Approval message update error: ' + error.message
    );
  }
}


/***********************
 * EMPLOYEE / APPROVER SYNC
 ***********************/

function syncEmployeesFromSlack() {
  const token = getSlackBotToken();

  let members = [];
  let cursor = '';

  do {
    let url =
      'https://slack.com/api/conversations.members?channel=' +
      encodeURIComponent(CHANNEL_ID) +
      '&limit=200';

    if (cursor) {
      url += '&cursor=' + encodeURIComponent(cursor);
    }

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + token
      },
      muteHttpExceptions: true
    });

    const data = JSON.parse(
      response.getContentText()
    );

    if (!data.ok) {
      throw new Error(
        'Unable to read channel members: ' + data.error
      );
    }

    members = members.concat(data.members || []);

    cursor =
      data.response_metadata &&
      data.response_metadata.next_cursor
        ? data.response_metadata.next_cursor
        : '';

  } while (cursor);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(EMPLOYEE_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(EMPLOYEE_SHEET);
  }

  const oldValues = sheet.getDataRange().getValues();
  const existing = {};

  for (let i = 1; i < oldValues.length; i++) {
    const id = String(oldValues[i][1] || '').trim();

    if (!id) {
      continue;
    }

    existing[id] = {
      shift: String(oldValues[i][2] || '').trim(),
      active: String(oldValues[i][3] || 'YES').trim(),
      tracking: String(oldValues[i][4] || 'YES').trim()
    };
  }

  sheet.clearContents();

  const headers = [
    'Employee',
    'Slack User ID',
    'Assigned Shift',
    'Active',
    'Attendance Tracking'
  ];

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]);

  const rows = [];

  members.forEach(function(userId) {
    const response = UrlFetchApp.fetch(
      'https://slack.com/api/users.info?user=' +
        encodeURIComponent(userId),
      {
        method: 'get',
        headers: {
          Authorization: 'Bearer ' + token
        },
        muteHttpExceptions: true
      }
    );

    const data = JSON.parse(
      response.getContentText()
    );

    if (!data.ok || !data.user) {
      return;
    }

    const user = data.user;

    if (user.is_bot || user.deleted) {
      return;
    }

    const name =
      user.real_name ||
      (user.profile && user.profile.display_name) ||
      user.name ||
      userId;

    const old = existing[userId];
    const tracking =
      EXCLUDED_ATTENDANCE_USER_IDS.indexOf(userId) !== -1
        ? 'NO'
        : 'YES';

    rows.push([
      name,
      userId,
      old ? old.shift : '',
      old ? old.active : 'YES',
      tracking
    ]);
  });

  rows.sort(function(a, b) {
    return String(a[0]).localeCompare(String(b[0]));
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length)
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
  formatEmployeeSheet(sheet);

  Logger.log('Employees synced: ' + rows.length);

  return {
    ok: true,
    members: rows.length
  };
}

function syncApproversFromSlack() {
  const token = getSlackBotToken();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(APPROVER_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(APPROVER_SHEET);
  }

  sheet.clearContents();

  const headers = [
    'Employee',
    'Slack User ID',
    'Designation',
    'Can Approve Leave'
  ];

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]);

  let members = [];
  let cursor = '';

  do {
    let url =
      'https://slack.com/api/users.list?limit=200';

    if (cursor) {
      url += '&cursor=' + encodeURIComponent(cursor);
    }

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + token
      },
      muteHttpExceptions: true
    });

    const data = JSON.parse(
      response.getContentText()
    );

    if (!data.ok) {
      throw new Error(
        'Slack users.list failed: ' + data.error
      );
    }

    members = members.concat(data.members || []);

    cursor =
      data.response_metadata &&
      data.response_metadata.next_cursor
        ? data.response_metadata.next_cursor
        : '';

  } while (cursor);

  const authorized = {};

  APPROVED_APPROVER_NAMES.forEach(function(name) {
    authorized[normalizeApproverName(name)] = true;
  });

  const rows = [];

  members.forEach(function(member) {
    if (member.deleted || member.is_bot) {
      return;
    }

    const name =
      member.real_name ||
      (member.profile && member.profile.real_name) ||
      (member.profile && member.profile.display_name) ||
      member.name ||
      '';

    if (!name) {
      return;
    }

    const designation =
      (member.profile && member.profile.title) || '';

    const normalizedName =
      normalizeApproverName(name);

    let canApprove = 'NO';

    Object.keys(authorized).some(function(authorizedName) {
      if (approverNameMatches(normalizedName, authorizedName)) {
        canApprove = 'YES';
        return true;
      }
      return false;
    });

    rows.push([
      name,
      member.id,
      designation,
      canApprove
    ]);
  });

  rows.sort(function(a, b) {
    return String(a[0]).localeCompare(String(b[0]));
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length)
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
  formatApproverSheet(sheet);

  Logger.log('Approvers synced: ' + rows.length);

  return {
    ok: true,
    members: rows.length
  };
}


/***********************
 * PERSONAL ATTENDANCE
 ***********************/

function buildPersonalAttendanceReply(userId) {
  const now = new Date();
  const workDate = getPersonalWorkDate(userId, now);
  const dateString = formatDate(workDate);
  const sheet = getOrCreateAttendanceSheet();
  const row = findAttendanceRow(
    sheet,
    dateString,
    userId
  );

  let message =
    '📊 *Your Attendance*\n' +
    '📅 Date: ' + dateString + '\n\n';

  if (!row) {
    return message +
      '🔴 Status: Not logged in / no attendance record found.';
  }

  message +=
    '👤 Employee: ' + String(row.employee || '') + '\n' +
    '🕐 Shift: ' + String(row.shift || '') + '\n';

  if (row.login) {
    message +=
      '🟢 Login: ' + formatDateTime(row.login) + '\n';
  } else {
    message += '🟡 Login: Not recorded\n';
  }

  if (row.logout) {
    message +=
      '🔵 Logout: ' + formatDateTime(row.logout) + '\n';
  } else {
    message += '🟡 Logout: Not recorded\n';
  }

  message += '📌 Status: ' + String(row.status || '') + '\n';

  if (row.total) {
    message += '⏱ Total Hours: ' + String(row.total);
  }

  return message;
}

function getPersonalWorkDate(userId, now) {
  const hour = Number(
    Utilities.formatDate(now, TIMEZONE, 'H')
  );

  if (hour < 6) {
    const result = new Date(now);
    result.setDate(result.getDate() - 1);
    return result;
  }

  return new Date(now);
}


/***********************
 * PERSONAL LEAVE
 ***********************/

function buildPersonalLeaveReply(userId) {
  const sheet = getOrCreateLeaveSheet();
  repairLegacyLeaveRows(sheet);

  const values = sheet.getDataRange().getValues();
  const headers = values[0];

  const dateCol = headers.indexOf('Leave Date');
  const employeeCol = headers.indexOf('Employee');
  const reasonCol = headers.indexOf('Reason');
  const informedCol = headers.indexOf('Informed To');
  const approvalRequestedCol =
    headers.indexOf('Approval Requested From');
  const approvedByCol = headers.indexOf('Approved By');
  const statusCol = headers.indexOf('Status');
  const submittedCol = headers.indexOf('Submitted At');
  const requestIdCol = headers.indexOf('Leave Request ID');
  const userIdCol = headers.indexOf('Slack User ID');

  const rows = [];

  for (let i = values.length - 1; i >= 1; i--) {
    const id = String(values[i][userIdCol] || '').trim();

    if (id !== String(userId).trim()) {
      continue;
    }

    rows.push({
      requestId: values[i][requestIdCol],
      date: values[i][dateCol],
      employee: values[i][employeeCol],
      reason: values[i][reasonCol],
      informedTo: values[i][informedCol],
      approvalRequestedFrom:
        values[i][approvalRequestedCol],
      approvedBy: values[i][approvedByCol],
      status: values[i][statusCol],
      submittedAt: values[i][submittedCol]
    });

    if (rows.length >= 15) {
      break;
    }
  }

  if (!rows.length) {
    return '📋 No leave records found for you.';
  }

  let message = '🏖 *Your Leave Records*\n\n';

  rows.forEach(function(item, index) {
    message +=
      (index + 1) + '. *' +
      formatDate(item.date) + '* — ' +
      String(item.status || 'Pending Approval') + '\n';

    if (item.reason) {
      message += 'Reason: ' + item.reason + '\n';
    }

    if (item.informedTo) {
      message += 'Informed To: ' + item.informedTo + '\n';
    }

    if (item.approvalRequestedFrom) {
      message +=
        'Approval Requested From: ' +
        item.approvalRequestedFrom + '\n';
    }

    if (item.approvedBy) {
      message += 'Approved By: ' + item.approvedBy + '\n';
    }

    message += 'Request ID: ' + item.requestId + '\n\n';
  });

  return message.trim();
}

function findApprovedLeave(userId, dateString) {
  const sheet = getOrCreateLeaveSheet();
  repairLegacyLeaveRows(sheet);

  const values = sheet.getDataRange().getValues();
  const headers = values[0];

  const dateCol = headers.indexOf('Leave Date');
  const userIdCol = headers.indexOf('Slack User ID');
  const reasonCol = headers.indexOf('Reason');
  const approvedByCol = headers.indexOf('Approved By');
  const statusCol = headers.indexOf('Status');

  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][userIdCol] || '').trim();
    const status = String(values[i][statusCol] || '')
      .trim()
      .toLowerCase();

    if (
      id === String(userId).trim() &&
      formatDate(values[i][dateCol]) === dateString &&
      status === 'approved'
    ) {
      return {
        reason: values[i][reasonCol] || '',
        approvedBy: values[i][approvedByCol] || ''
      };
    }
  }

  return null;
}


/***********************
 * CORRECTIONS
 ***********************/

function looksLikeCorrection(text) {
  const phrases = [
    'forgot to log in',
    'forgot login',
    'forgot to login',
    'missed login',
    'forgot to log out',
    'forgot logout',
    'forgot to logout',
    'missed logout',
    'forgot to punch in',
    'forgot to punch out',
    'missed punch in',
    'missed punch out'
  ];

  return phrases.some(function(phrase) {
    return text.indexOf(phrase) !== -1;
  });
}

function recordCorrectionRequest(
  userId,
  message,
  eventTs
) {
  const sheet = getOrCreateCorrectionSheet();
  const employeeName = getSlackUserName(userId);

  let type = 'Attendance Correction';
  const lower = String(message || '').toLowerCase();

  if (
    lower.indexOf('log out') !== -1 ||
    lower.indexOf('logout') !== -1 ||
    lower.indexOf('punch out') !== -1
  ) {
    type = 'Missing Logout';
  } else if (
    lower.indexOf('log in') !== -1 ||
    lower.indexOf('login') !== -1 ||
    lower.indexOf('punch in') !== -1
  ) {
    type = 'Missing Login';
  }

  const submittedAt = slackTsToDate(eventTs);

  sheet.appendRow([
    getPersonalWorkDate(userId, submittedAt),
    employeeName,
    userId,
    type,
    message,
    submittedAt,
    'Pending Approval'
  ]);

  formatCorrectionSheet(sheet);
}


/***********************
 * AUTOMATED REPORTS
 ***********************/

function installSummaryTrigger() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(trigger) {
    if (
      trigger.getHandlerFunction() ===
      'runScheduledReports'
    ) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('runScheduledReports')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('Scheduled report trigger installed.');
}

function runScheduledReports() {
  processQueuedSlackInteractions();
  const now = new Date();

  if (isWithinScheduledWindow(now, 5, 55, REPORT_WINDOW_MINUTES)) {
    runOncePerDay('DAILY_SYNC', now, function() {
      syncEmployeesFromSlack();
      syncApproversFromSlack();
    });
  }

  if (isWithinScheduledWindow(now, 7, 0, REPORT_WINDOW_MINUTES)) {
    sendReportOnce('MORNING_CHECKIN', getWorkDateForMorning(now), function() {
      return buildCurrentPresentReport(MORNING_SHIFT, getWorkDateForMorning(now), '7:00 AM');
    });
  }

  if (isWithinScheduledWindow(now, 15, 45, REPORT_WINDOW_MINUTES)) {
    sendReportOnce('MORNING_FINAL', getWorkDateForMorning(now), function() {
      return buildFinalShiftReport(MORNING_SHIFT, getWorkDateForMorning(now));
    });
  }

  if (isWithinScheduledWindow(now, 16, 0, REPORT_WINDOW_MINUTES)) {
    sendReportOnce('EVENING_CHECKIN', getWorkDateForEvening(now), function() {
      return buildCurrentPresentReport(EVENING_SHIFT, getWorkDateForEvening(now), '4:00 PM');
    });
  }

  if (isWithinScheduledWindow(now, 0, 30, REPORT_WINDOW_MINUTES)) {
    sendReportOnce('EVENING_FINAL', getPreviousWorkDate(now), function() {
      return buildFinalShiftReport(EVENING_SHIFT, getPreviousWorkDate(now));
    });
  }
}

function isWithinScheduledWindow(
  date,
  targetHour,
  targetMinute,
  windowMinutes
) {
  const hour = Number(
    Utilities.formatDate(date, TIMEZONE, 'H')
  );

  const minute = Number(
    Utilities.formatDate(date, TIMEZONE, 'm')
  );

  const current = hour * 60 + minute;
  const target = targetHour * 60 + targetMinute;

  let diff = current - target;

  if (diff < 0) {
    diff += 1440;
  }

  return diff >= 0 && diff <= windowMinutes;
}

function runOncePerDay(key, date, callback) {
  const dateString = formatDate(date);
  const props = PropertiesService.getScriptProperties();
  const propertyKey = 'DAILY_DONE_' + key + '_' + dateString;
  if (props.getProperty(propertyKey)) return;
  callback();
  props.setProperty(propertyKey, new Date().toISOString());
}

function sendReportOnce(reportType, workDate, builder) {
  const dateString = formatDate(workDate);
  const props = PropertiesService.getScriptProperties();
  const key = 'REPORT_SENT_' + reportType + '_' + dateString;
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    console.warn('Report already being processed: ' + key);
    return;
  }

  try {
    if (props.getProperty(key)) return;
    const message = builder();
    sendSlackMessage(CHANNEL_ID, message);
    props.setProperty(key, new Date().toISOString());
  } finally {
    lock.releaseLock();
  }
}

function buildCurrentPresentReport(
  shift,
  workDate,
  cutoff
) {
  const dateString = formatDate(workDate);
  const employees = getTrackedEmployeesForShift(shift, workDate);
  const attendance = getAttendanceForDate(dateString);
  const approvedLeaves = getApprovedLeavesForDate(dateString);

  const present = [];
  const notLoggedIn = [];
  const onLeave = [];

  employees.forEach(function(employee) {
    const leave = approvedLeaves[employee.userId];

    if (leave) {
      onLeave.push(employee.name);
      return;
    }

    const row = attendance[employee.userId];

    if (row && row.login) {
      present.push(employee.name);
    } else {
      notLoggedIn.push(employee.name);
    }
  });

  let message =
    '📊 *VExa Attendance — ' + shift + '*\n' +
    '📅 Date: ' + dateString + '\n' +
    '⏰ Check-in Report: ' + cutoff + '\n\n';

  message +=
    '🟢 *Present: ' + present.length + '*\n' +
    (present.length
      ? present.map(function(name) {
          return '• ' + name;
        }).join('\n')
      : '• None') + '\n\n';

  message +=
    '🔴 *Not Logged In: ' + notLoggedIn.length + '*\n' +
    (notLoggedIn.length
      ? notLoggedIn.map(function(name) {
          return '• ' + name;
        }).join('\n')
      : '• None');

  if (onLeave.length) {
    message +=
      '\n\n🏖 *Approved Leave: ' + onLeave.length + '*\n' +
      onLeave.map(function(name) {
        return '• ' + name;
      }).join('\n');
  }

  return message;
}

function buildFinalShiftReport(shift, workDate) {
  const dateString = formatDate(workDate);
  const employees = getTrackedEmployeesForShift(shift, workDate);
  const attendance = getAttendanceForDate(dateString);
  const approvedLeaves = getApprovedLeavesForDate(dateString);

  const present = [];
  const absent = [];
  const onLeave = [];

  employees.forEach(function(employee) {
    const leave = approvedLeaves[employee.userId];

    if (leave) {
      onLeave.push({
        name: employee.name,
        reason: leave.reason
      });
      return;
    }

    const row = attendance[employee.userId];

    if (
      row &&
      row.login &&
      row.logout
    ) {
      present.push({
        name: employee.name,
        total: row.total
      });
    }
    else if (
      row &&
      row.login &&
      !row.logout
    ) {
      absent.push(employee.name + ' (Not Logged Out)');
    }
    else if (
      row &&
      row.logout &&
      !row.login
    ) {
      absent.push(employee.name + ' (Missing Login)');
    }
    else {
      absent.push(employee.name + ' (Missing Login)');
    }
  });

  let message =
    '📊 *VExa Final Attendance Report*\n' +
    '📅 Date: ' + dateString + '\n' +
    '🕐 Shift: ' + shift + '\n\n';

  message +=
    '🟢 *Present: ' + present.length + '*\n';

  if (present.length) {
    message += present.map(function(item) {
      return '• ' + item.name + ' — ' + item.total;
    }).join('\n');
  } else {
    message += '• None';
  }

  message += '\n\n🔴 *Absent: ' + absent.length + '*\n';

  if (absent.length) {
    message += absent.map(function(name) {
      return '• ' + name;
    }).join('\n');
  } else {
    message += '• None';
  }

  message +=
    '\n\n🏖 *Approved Leave: ' + onLeave.length + '*\n';

  if (onLeave.length) {
    message += onLeave.map(function(item) {
      return '• ' + item.name +
        (item.reason ? ' — ' + item.reason : '');
    }).join('\n');
  } else {
    message += '• None';
  }

  return message;
}

function getTrackedEmployeesForShift(shift, workDate) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(EMPLOYEE_SHEET);

  if (!sheet) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  const employees = [];
  const targetShift = normalizeShift(shift);
  const attendance = workDate
    ? getAttendanceForDate(formatDate(workDate))
    : {};

  for (let i = 1; i < values.length; i++) {
    const name = String(values[i][0] || '').trim();
    const userId = String(values[i][1] || '').trim();
    const assignedShift = normalizeShift(values[i][2] || '');
    const active = String(values[i][3] || 'YES').trim().toUpperCase();
    const tracking = String(values[i][4] || 'YES').trim().toUpperCase();

    if (!name || !userId || active !== 'YES' || tracking !== 'YES') {
      continue;
    }

    if (assignedShift === targetShift) {
      employees.push({
        name: name,
        userId: userId,
        shift: targetShift
      });
      continue;
    }

    // For employees without an assigned shift, use the shift locked at login.
    if (!assignedShift && attendance[userId]) {
      if (normalizeShift(attendance[userId].shift) === targetShift) {
        employees.push({
          name: name,
          userId: userId,
          shift: targetShift
        });
      }
    }
  }

  return employees;
}

function getAttendanceForDate(dateString) {
  const sheet = getOrCreateAttendanceSheet();
  const values = sheet.getDataRange().getValues();
  const result = {};

  for (let i = 1; i < values.length; i++) {
    if (formatDate(values[i][0]) !== dateString) continue;

    const userId = String(values[i][2] || '').trim();
    if (!userId) continue;

    const candidate = {
      employee: values[i][1],
      userId: userId,
      shift: values[i][3],
      login: values[i][4],
      logout: values[i][5],
      total: values[i][6],
      status: values[i][7]
    };

    const existing = result[userId];
    if (!existing) {
      result[userId] = candidate;
      continue;
    }

    const existingScore = (existing.login ? 1 : 0) + (existing.logout ? 1 : 0);
    const candidateScore = (candidate.login ? 1 : 0) + (candidate.logout ? 1 : 0);

    if (candidateScore > existingScore ||
        (candidateScore === existingScore && candidate.logout)) {
      result[userId] = candidate;
    }
  }

  return result;
}

function getApprovedLeavesForDate(dateString) {
  const sheet = getOrCreateLeaveSheet();
  repairLegacyLeaveRows(sheet);

  const values = sheet.getDataRange().getValues();
  const headers = values[0];

  const dateCol = headers.indexOf('Leave Date');
  const userIdCol = headers.indexOf('Slack User ID');
  const reasonCol = headers.indexOf('Reason');
  const approvedByCol = headers.indexOf('Approved By');
  const statusCol = headers.indexOf('Status');

  const result = {};

  for (let i = 1; i < values.length; i++) {
    const date = formatDate(values[i][dateCol]);
    const userId = String(values[i][userIdCol] || '').trim();
    const status = String(values[i][statusCol] || '')
      .trim()
      .toLowerCase();

    if (
      date === dateString &&
      userId &&
      status === 'approved'
    ) {
      result[userId] = {
        reason: values[i][reasonCol] || '',
        approvedBy: values[i][approvedByCol] || ''
      };
    }
  }

  return result;
}

function getWorkDateForMorning(now) {
  return new Date(now);
}

function getWorkDateForEvening(now) {
  return new Date(now);
}

function getPreviousWorkDate(now) {
  const result = new Date(now);
  result.setDate(result.getDate() - 1);
  return result;
}


/***********************
 * SHEET CREATION / SCHEMA
 ***********************/

function getOrCreateAttendanceSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ATTENDANCE_SHEET);

  const headers = [
    'Date',
    'Employee',
    'Slack User ID',
    'Shift',
    'Login',
    'Logout',
    'Total Hours',
    'Status'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SHEET);
  }

  ensureHeaderRow(sheet, headers);
  formatAttendanceSheet(sheet);

  return sheet;
}

function getOrCreateLeaveSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LEAVE_SHEET);

  const headers = [
    'Leave Request ID',
    'Leave Date',
    'Employee',
    'Slack User ID',
    'Reason',
    'Informed To',
    'Approval Requested From',
    'Approved By',
    'Submitted At',
    'Status'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(LEAVE_SHEET);
  }

  ensureHeaderRow(sheet, headers);
  repairLegacyLeaveRows(sheet);
  formatLeaveSheet(sheet);

  return sheet;
}

function getOrCreateCorrectionSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CORRECTION_SHEET);

  const headers = [
    'Date',
    'Employee',
    'Slack User ID',
    'Correction Type',
    'Request',
    'Submitted At',
    'Status'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(CORRECTION_SHEET);
  }

  ensureHeaderRow(sheet, headers);
  formatCorrectionSheet(sheet);

  return sheet;
}

function ensureHeaderRow(sheet, headers) {
  const current = sheet
    .getRange(1, 1, 1, headers.length)
    .getValues()[0];

  let matches = true;

  for (let i = 0; i < headers.length; i++) {
    if (String(current[i] || '').trim() !== headers[i]) {
      matches = false;
      break;
    }
  }

  if (!matches) {
    sheet.getRange(1, 1, 1, headers.length)
      .setValues([headers]);
  }

  sheet.setFrozenRows(1);
}

function repairLegacyLeaveRows(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();

  if (values.length < 2) {
    return;
  }

  const headers = values[0];

  if (
    headers.indexOf('Leave Request ID') !== 0 ||
    headers.indexOf('Leave Date') !== 1 ||
    headers.indexOf('Employee') !== 2 ||
    headers.indexOf('Slack User ID') !== 3 ||
    headers.indexOf('Status') !== 9
  ) {
    return;
  }

  const validStatuses = {
    'Pending Approval': true,
    'Approved': true,
    'Rejected': true
  };

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const requestId = String(row[0] || '').trim();
    const leaveDate = row[1];
    const employee = String(row[2] || '').trim();
    const slackUserId = String(row[3] || '').trim();
    const reason = String(row[4] || '').trim();
    const status = String(row[9] || '').trim();

    if (!requestId && !employee && !slackUserId) {
      continue;
    }

    // Repair the older 8-column Leaves layout when it was copied into
    // the current 10-column sheet. In that layout:
    // A=Leave Request/Date, B=Employee, C=Slack ID, D=Reason,
    // E=Informed To, F=Approved By, G=Submitted At, H=Status.
    const looksOldEightColumnRow =
      !requestId.startsWith('LR-') &&
      !!employee &&
      /^[UW][A-Z0-9]+$/.test(slackUserId);

    if (looksOldEightColumnRow) {
      const oldRequestId =
        'LR-LEGACY-' +
        Utilities.getUuid().substring(0, 8);

      const oldApprovedBy = String(row[5] || '').trim();
      const oldSubmittedAt = row[6] || '';
      const oldStatus =
        String(row[7] || 'Pending Approval').trim() ||
        'Pending Approval';

      sheet.getRange(i + 1, 1, 1, 10).setValues([[
        oldRequestId,
        parseDateValue(leaveDate),
        employee,
        slackUserId,
        reason,
        row[4] || '',
        '',
        oldApprovedBy,
        parseDateTimeValue(oldSubmittedAt),
        validStatuses[oldStatus] ? oldStatus : 'Pending Approval'
      ]]);

      continue;
    }

    // Repair rows that already have an LR-/LR-LEGACY request ID but whose
    // submitted timestamp was accidentally written into Status.
    if (
      requestId.startsWith('LR-') &&
      !validStatuses[status]
    ) {
      const possibleSubmittedAt = row[9];

      if (
        possibleSubmittedAt &&
        isDateLike(possibleSubmittedAt)
      ) {
        sheet.getRange(i + 1, 9).setValue(
          parseDateTimeValue(possibleSubmittedAt)
        );
      }

      sheet.getRange(i + 1, 10).setValue(
        'Pending Approval'
      );
    }
  }
}

function isDateLike(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return true;
  }

  const parsed = new Date(String(value || ''));
  return !isNaN(parsed.getTime());
}

/***********************
 * FORMATTING
 ***********************/

function formatAttendanceSheet(sheet) {
  if (sheet.getLastColumn() < 8) {
    return;
  }

  sheet.getRange(1, 1, 1, 8)
    .setFontWeight('bold');

  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .setNumberFormat('yyyy-mm-dd');

    sheet.getRange(2, 5, sheet.getLastRow() - 1, 2)
      .setNumberFormat('dd-mm-yyyy hh:mm:ss');
  }

  sheet.autoResizeColumns(1, 8);
}

function formatEmployeeSheet(sheet) {
  if (sheet.getLastRow() >= 1) {
    sheet.getRange(1, 1, 1, 5)
      .setFontWeight('bold');
  }
  sheet.autoResizeColumns(1, 5);
}

function formatLeaveSheet(sheet) {
  if (sheet.getLastRow() >= 1) {
    sheet.getRange(1, 1, 1, 10)
      .setFontWeight('bold');
  }

  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
      .setNumberFormat('yyyy-mm-dd');

    sheet.getRange(2, 9, sheet.getLastRow() - 1, 1)
      .setNumberFormat('dd-mm-yyyy hh:mm:ss');
  }

  sheet.autoResizeColumns(1, 10);
}

function formatCorrectionSheet(sheet) {
  if (sheet.getLastRow() >= 1) {
    sheet.getRange(1, 1, 1, 7)
      .setFontWeight('bold');
  }

  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .setNumberFormat('yyyy-mm-dd');

    sheet.getRange(2, 6, sheet.getLastRow() - 1, 1)
      .setNumberFormat('dd-mm-yyyy hh:mm:ss');
  }

  sheet.autoResizeColumns(1, 7);
}

function formatApproverSheet(sheet) {
  if (sheet.getLastRow() >= 1) {
    sheet.getRange(1, 1, 1, 4)
      .setFontWeight('bold');
  }
  sheet.autoResizeColumns(1, 4);
}


/***********************
 * SLACK HELPERS
 ***********************/

function getSlackBotToken() {
  const token = PropertiesService
    .getScriptProperties()
    .getProperty('SLACK_BOT_TOKEN');

  if (!token) {
    throw new Error('SLACK_BOT_TOKEN is missing.');
  }

  return token;
}

function openDirectMessage(userId) {
  const response = UrlFetchApp.fetch(
    'https://slack.com/api/conversations.open',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization:
          'Bearer ' + getSlackBotToken()
      },
      payload: JSON.stringify({
        users: userId
      }),
      muteHttpExceptions: true
    }
  );

  const data = JSON.parse(
    response.getContentText()
  );

  if (!data.ok || !data.channel || !data.channel.id) {
    throw new Error(
      'Could not open DM: ' +
        (data.error || 'unknown_error')
    );
  }

  return data.channel.id;
}

function getReplyChannelForUser(userId) {
  // For normal message events, the calling code already has the DM channel.
  // This function is used only for attendance messages created directly by
  // recordAttendance, so open a DM with the user.
  return openDirectMessage(userId);
}

function sendSlackMessage(channel, text, threadTs) {
  const resolvedChannel =
    String(channel || '').trim();

  if (!resolvedChannel) {
    throw new Error('Slack channel is missing.');
  }

  if (
    resolvedChannel.charAt(0) === 'U'
  ) {
    return sendSlackMessageToUser(
      resolvedChannel,
      text
    );
  }

  const payload = {
    channel: resolvedChannel,
    text: text
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const response = UrlFetchApp.fetch(
    'https://slack.com/api/chat.postMessage',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization:
          'Bearer ' + getSlackBotToken()
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  const data = JSON.parse(
    response.getContentText()
  );

  if (!data.ok) {
    throw new Error(
      'Slack send error: ' +
        (data.error || 'unknown_error')
    );
  }

  return data;
}

function sendSlackMessageToUser(userId, text) {
  const dmChannel = openDirectMessage(userId);

  return sendSlackMessage(
    dmChannel,
    text
  );
}

function cleanSlackMentions(text) {
  return String(text || '')
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMessage(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


/***********************
 * SLACK USER NAME
 ***********************/

function getSlackUserName(userId) {
  const token = getSlackBotToken();

  const response = UrlFetchApp.fetch(
    'https://slack.com/api/users.info?user=' +
      encodeURIComponent(userId),
    {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + token
      },
      muteHttpExceptions: true
    }
  );

  const data = JSON.parse(
    response.getContentText()
  );

  if (
    data.ok &&
    data.user
  ) {
    return (
      data.user.real_name ||
      (data.user.profile && data.user.profile.real_name) ||
      (data.user.profile && data.user.profile.display_name) ||
      data.user.name ||
      userId
    );
  }

  return userId;
}


/***********************
 * DUPLICATE EVENTS
 ***********************/

function wasProcessed(eventId) {
  return !!CacheService
    .getScriptCache()
    .get('EVENT_' + eventId);
}

function markProcessed(eventId) {
  CacheService
    .getScriptCache()
    .put(
      'EVENT_' + eventId,
      '1',
      MESSAGE_CACHE_SECONDS
    );
}


/***********************
 * DATE HELPERS
 ***********************/

function slackTsToDate(slackTs) {
  const seconds = parseFloat(slackTs);

  if (isNaN(seconds)) {
    return new Date();
  }

  return new Date(seconds * 1000);
}

function formatDate(date) {
  if (!date) {
    return '';
  }

  if (
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return date;
  }

  return Utilities.formatDate(
    new Date(date),
    TIMEZONE,
    'yyyy-MM-dd'
  );
}

function formatDateTime(date) {
  if (!date) {
    return '';
  }

  return Utilities.formatDate(
    new Date(date),
    TIMEZONE,
    'dd-MM-yyyy HH:mm:ss'
  );
}

function parseISODate(value) {
  if (!value) {
    return null;
  }

  const parts = String(value).split('-');

  if (parts.length !== 3) {
    return null;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (
    isNaN(year) ||
    isNaN(month) ||
    isNaN(day)
  ) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function parseDateValue(value) {
  if (value instanceof Date) {
    return value;
  }

  return parseISODate(String(value || '')) || new Date();
}

function parseDateTimeValue(value) {
  if (!value) {
    return '';
  }

  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);

  return isNaN(parsed.getTime()) ? '' : parsed;
}


/***********************
 * INITIALIZATION
 ***********************/

function initializeVexaSystem() {
  getOrCreateAttendanceSheet();
  getOrCreateLeaveSheet();
  getOrCreateCorrectionSheet();

  syncEmployeesFromSlack();
  syncApproversFromSlack();
  installSummaryTrigger();

  Logger.log(
    'VExa Attendance System initialized successfully.'
  );
}

function testSystemSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const result = {
    Attendance: !!ss.getSheetByName(ATTENDANCE_SHEET),
    Employees: !!ss.getSheetByName(EMPLOYEE_SHEET),
    Leaves: !!ss.getSheetByName(LEAVE_SHEET),
    Corrections: !!ss.getSheetByName(CORRECTION_SHEET),
    Approvers: !!ss.getSheetByName(APPROVER_SHEET),
    SlackToken: !!PropertiesService
      .getScriptProperties()
      .getProperty('SLACK_BOT_TOKEN'),
    OpenAIKey: !!PropertiesService
      .getScriptProperties()
      .getProperty('OPENAI_API_KEY')
  };

  Logger.log(JSON.stringify(result, null, 2));

  return result;
}

function testOpenAIConnection() {
  const key = PropertiesService
    .getScriptProperties()
    .getProperty('OPENAI_API_KEY');

  if (!key) {
    throw new Error('OPENAI_API_KEY is missing.');
  }

  const response = UrlFetchApp.fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + key
      },
      payload: JSON.stringify({
        model: OPENAI_MODEL,
        input: 'Reply with exactly: OpenAI connection successful'
      }),
      muteHttpExceptions: true
    }
  );

  Logger.log(
    'HTTP Status: ' + response.getResponseCode()
  );

  Logger.log(response.getContentText());
}

function testSlackConnection() {
  const response = UrlFetchApp.fetch(
    'https://slack.com/api/auth.test',
    {
      method: 'get',
      headers: {
        Authorization:
          'Bearer ' + getSlackBotToken()
      },
      muteHttpExceptions: true
    }
  );

  Logger.log(response.getContentText());
}

function testLeaveAIConnection() {
  const sampleMessage =
    'I would like to take leave on Monday for personal work. I have requested approval from Vamsi sir.';

  const result = extractLeaveWithAI(
    sampleMessage,
    'TEST_USER',
    String(Date.now() / 1000)
  );

  Logger.log(
    JSON.stringify(result, null, 2)
  );

  return result;
}



/***********************
 * JSON RESPONSE
 ***********************/

function jsonResponse(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}


/***********************
 * SIMPLE GET HEALTH CHECK
 ***********************/

function doGet() {
  return ContentService
    .createTextOutput('VExa Attendance Bot is running.')
    .setMimeType(ContentService.MimeType.TEXT);
}
