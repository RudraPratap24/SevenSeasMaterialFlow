/******************************************************************************
 * SEVEN SEAS – PURCHASE SYSTEM · Apps Script front door
 *
 * The page stays on this Google link. Every call the page makes (google.script.run.<fn>) is passed to the backend,
 * which keeps all data in the database — the sheets are no longer read or written.
 *
 * SETUP (once)
 *   1. Replace the old Code.gs with this file, and the old Index.html with the Index.html next to it.
 *   2. Project Settings ▸ Script Properties ▸ add  API_BASE = https://<the backend address>   (no slash at the end)
 *   3. Project Settings ▸ Time zone = (GMT+05:30) India Standard Time.
 *   4. Triggers ▸ delete the old autoRun and dailyDigest triggers (the backend does that work now).
 *   5. Deploy ▸ Manage deployments ▸ edit the current web app ▸ Version: New version ▸ Deploy. Same link as before.
 ******************************************************************************/

const PORTAL = 'Seven Seas Purchase System';

function apiBase_() {
  const b = PropertiesService.getScriptProperties().getProperty('API_BASE');
  if (!b) throw new Error('API_BASE is not set (Project Settings ▸ Script Properties).');
  return b.replace(/\/+$/, '');
}

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.mode = (e && e.parameter && /^indent$/i.test(e.parameter.page || '')) ? 'indent' : 'app';
  t.apiBase = apiBase_();
  return t.evaluate().setTitle(PORTAL).addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** one call to the backend; its error text reaches the page unchanged (SESSION_EXPIRED, INACTIVE_VENDOR: …) */
function call_(fn, args) {
  const r = UrlFetchApp.fetch(apiBase_() + '/api/ps/call/' + fn, {
    method: 'post', contentType: 'application/json', headers: {'x-flow-request': '1'},
    payload: JSON.stringify({args: args}), muteHttpExceptions: true, followRedirects: false
  });
  let j = null;
  try { j = JSON.parse(r.getContentText()); } catch (e) { throw new Error('The server did not answer (' + r.getResponseCode() + ').'); }
  if (j && j.error) throw new Error(j.error);
  return j ? j.result : null;
}
const pass_ = (fn, a) => call_(fn, Array.prototype.slice.call(a));

/* the 33 functions the page calls — same names and arguments as before */
function getLoginBoot() { return pass_('getLoginBoot', arguments); }
function login() { return pass_('login', arguments); }
function logout() { return pass_('logout', arguments); }
function indentLogin() { return pass_('indentLogin', arguments); }
function getPublicBoot() { return pass_('getPublicBoot', arguments); }
function getAppBoot() { return pass_('getAppBoot', arguments); }
function getHome() { return pass_('getHome', arguments); }
function getIndents() { return pass_('getIndents', arguments); }
function getIndentVisibility() { return pass_('getIndentVisibility', arguments); }
function checkRepeat() { return pass_('checkRepeat', arguments); }
function submitIndent() { return pass_('submitIndent', arguments); }
function closeIndents() { return pass_('closeIndents', arguments); }
function getPoMakerData() { return pass_('getPoMakerData', arguments); }
function createPo() { return pass_('createPo', arguments); }
function getPoVisibility() { return pass_('getPoVisibility', arguments); }
function approvePo() { return pass_('approvePo', arguments); }
function cancelPo() { return pass_('cancelPo', arguments); }
function getMailDraft() { return pass_('getMailDraft', arguments); }
function sendPoMail() { return pass_('sendPoMail', arguments); }
function uploadSigned() { return pass_('uploadSigned', arguments); }
function getTallyXml() { return pass_('getTallyXml', arguments); }
function getTasks() { return pass_('getTasks', arguments); }
function updateTasks() { return pass_('updateTasks', arguments); }
function getGrnList() { return pass_('getGrnList', arguments); }
function getAnalytics() { return pass_('getAnalytics', arguments); }
function getPerformance() { return pass_('getPerformance', arguments); }
function getAdminInfo() { const r = pass_('getAdminInfo', arguments); r.url = ScriptApp.getService().getUrl() || r.url; return r; }   // the public indent link = this Google link
function adminRun() { return pass_('adminRun', arguments); }
function getUsersAdmin() { return pass_('getUsersAdmin', arguments); }
function setUserActive() { return pass_('setUserActive', arguments); }
function setUserPassword() { return pass_('setUserPassword', arguments); }
function getItemPhoto() { return pass_('getItemPhoto', arguments); }
function setItemPhoto() { return pass_('setItemPhoto', arguments); }
