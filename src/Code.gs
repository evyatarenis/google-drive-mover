/**
 * Google Drive Mover
 * ------------------
 * Moves everything inside a folder shared FROM one Google account into
 * another account's Drive, so the files use the other account's storage.
 * See README.md for the full step-by-step guide.
 *
 * DISCLAIMER: This script is provided "as is", without warranty of any kind.
 * You use it at your own risk. The author is not responsible for any damage
 * or data loss it may or may not cause. Check your copies before deleting
 * anything. See LICENSE.
 *
 * Use it from the web page (Deploy > Test deployments > Web app), or run the
 * functions from the editor:
 *
 * In the DESTINATION account (the one that receives the files):
 *   previewCopy()     - dry run: lists what would be copied. Changes nothing.
 *   startCopy()       - copies the folder. Continues by itself every few
 *                       minutes (Apps Script stops each run after ~6 minutes)
 *                       and emails you when it is finished. Safe to run
 *                       again: files that were already copied are skipped.
 *   verifyCopy()      - compares source and copy and emails a report.
 *   stopCopy()        - cancels the automatic continuation.
 *
 * In the SOURCE account (the one you want to free up):
 *   deleteOriginals() - moves the files this account OWNS inside the folder
 *                       to the Bin. Dry run until you set CONFIRM_DELETE.
 */

// ===== Settings =============================================================
// When you use the web page, the values saved there take priority over these.

// ID of the folder shared from the source account. It is the part of the
// folder's address after /folders/
const SOURCE_FOLDER_ID = 'PASTE_FOLDER_ID_HERE';

// Name of the folder that is created in My Drive of the destination account.
const DEST_FOLDER_NAME = 'Copied from old account';

// true:  copy what a shortcut points to (a folder's contents, or the file).
// false: copy only the shortcut itself (a link).
const FOLLOW_SHORTCUTS = true;

// Used by deleteOriginals() from the editor. Leave false for a dry run that
// lists what would be moved to the Bin. Set to true only after verifyCopy
// looks right. (The web page asks for confirmation instead.)
const CONFIRM_DELETE = false;

// ============================================================================

const MAX_RUNTIME_MS = 5 * 60 * 1000;  // stop before Google's 6-minute limit
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
// Types that makeCopy() can't copy. They have to be copied by hand.
const UNSUPPORTED_MIMES = {
  'application/vnd.google-apps.script': 'Apps Script project',
  'application/vnd.google-apps.site': 'Google Site',
};

let cfg;                 // effective settings, see loadSettings_()
let confirmDelete = false;
let startTime;
let copiedThisRun = 0;
let errors = [];

// ---------- Web page --------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Google Drive Mover')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Everything the page needs to draw itself. */
function getState() {
  const s = loadSettings_();
  const p = props_().getProperties();
  return {
    account: Session.getActiveUser().getEmail(),
    settings: { sourceFolderId: s.sourceFolderId === 'PASTE_FOLDER_ID_HERE' ? '' : s.sourceFolderId,
                destFolderName: s.destFolderName, followShortcuts: s.followShortcuts },
    sourceFolderName: folderName_(s.sourceFolderId),
    sourceFolderOwner: folderOwner_(s.sourceFolderId),
    copy: { status: p.copyStatus || 'idle', total: Number(p.copyTotal || 0),
            lastRun: p.copyLastRun || '', errors: Number(p.copyErrors || 0) },
    del: { status: p.deleteStatus || 'idle', lastRun: p.deleteLastRun || '' },
  };
}

function saveSettings(s) {
  const id = extractId_(s.sourceFolderId || '');
  if (!id) throw new Error('Paste the folder link or its ID.');
  try { DriveApp.getFolderById(id); } catch (e) {
    throw new Error('This account can\'t open that folder. Is it shared with ' +
      Session.getActiveUser().getEmail() + '?');
  }
  const name = String(s.destFolderName || '').trim() || DEST_FOLDER_NAME;
  const old = props_().getProperties();
  if (old.sourceFolderId !== id || old.destFolderName !== name) {
    // A different copy job: start the progress counters from zero.
    ['copyStatus', 'copyTotal', 'copyErrors', 'copyLastRun', 'deleteStatus', 'deleteLastRun']
      .forEach(k => props_().deleteProperty(k));
  }
  props_().setProperties({
    sourceFolderId: id, destFolderName: name, followShortcuts: s.followShortcuts ? '1' : '0',
  });
  return getState();
}

/** Called by the page. Returns the report text. */
function runFromPage(action, confirmed) {
  switch (action) {
    case 'preview': return previewCopy();
    case 'copy':    return startCopy();
    case 'verify':  return verifyCopy();
    case 'stop':    stopCopy(); return 'Stopped. Run Copy again to continue where it left off.';
    case 'delete':  return deleteOriginals(confirmed === true);
  }
  throw new Error('Unknown action: ' + action);
}

// ---------- Copy ------------------------------------------------------------

function startCopy() {
  loadSettings_();
  checkSettings_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'A copy run is already in progress. Wait a few minutes and check again.';
  try { return startCopyLocked_(); } finally { lock.releaseLock(); }
}

function startCopyLocked_() {
  startTime = Date.now();
  copiedThisRun = 0;
  errors = [];
  deleteTriggers_('startCopy');
  setProps_({ copyStatus: 'copying', copyLastRun: new Date().toISOString() });

  const source = DriveApp.getFolderById(cfg.sourceFolderId);
  const dest = getOrCreateChildFolder_(DriveApp.getRootFolder(), cfg.destFolderName);

  const finished = copyFolder_(source, dest, new Set());

  const p = props_();
  setProps_({
    copyTotal: String(Number(p.getProperty('copyTotal') || 0) + copiedThisRun),
    copyErrors: String(errors.length),
  });

  const lines = ['Copied this run: ' + copiedThisRun];
  if (errors.length) lines.push('', 'Could not copy:', ...errors);

  if (finished) {
    setProps_({ copyStatus: 'done' });
    MailApp.sendEmail(
      Session.getActiveUser().getEmail(),
      'Drive copy finished',
      'All files were copied into "' + cfg.destFolderName + '".\n\n' +
      (errors.length ? 'These could not be copied:\n' + errors.join('\n') : 'No errors.') +
      '\n\nNext step: run verifyCopy to check that nothing is missing.' +
      '\n\nThis script comes with no warranty; you use it at your own risk.'
    );
    lines.push('', 'All done. Next step: Verify.');
  } else {
    ScriptApp.newTrigger('startCopy').timeBased().after(60 * 1000).create();
    lines.push('', 'Time limit reached - continuing automatically in about 1 minute.',
               'You can close this page. You will get an email when it is finished.');
  }
  const report = lines.join('\n');
  Logger.log(report);
  return report;
}

function stopCopy() {
  deleteTriggers_('startCopy');
  deleteTriggers_('deleteOriginals');
  const p = props_();
  if (p.getProperty('copyStatus') === 'copying') p.setProperty('copyStatus', 'stopped');
  if (p.getProperty('deleteStatus') === 'deleting') p.setProperty('deleteStatus', 'stopped');
  p.deleteProperty('deleteConfirmed');
  Logger.log('Automatic continuation cancelled.');
}

/** Returns true when the folder is fully copied, false if it ran out of time. */
function copyFolder_(source, dest, visited) {
  if (visited.has(source.getId())) return true;  // shortcut loop
  visited.add(source.getId());

  // Count what already exists in the destination, so re-runs skip finished
  // files (and files that share a name are still all copied).
  const existing = {};
  const destFiles = dest.getFiles();
  while (destFiles.hasNext()) {
    const n = destFiles.next().getName();
    existing[n] = (existing[n] || 0) + 1;
  }

  const seen = {};
  const shortcutFolders = [];
  const files = source.getFiles();
  while (files.hasNext()) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) return false;
    const file = files.next();
    const name = file.getName();

    let toCopy = file;
    if (cfg.followShortcuts && file.getMimeType() === SHORTCUT_MIME) {
      const t = resolveShortcut_(file);
      if (!t) { errors.push(name + ' (shortcut target not accessible)'); continue; }
      if (t.folder) { shortcutFolders.push({ name: name, folder: t.folder }); continue; }
      toCopy = t.file;
    }

    seen[name] = (seen[name] || 0) + 1;
    if ((existing[name] || 0) >= seen[name]) continue; // already copied

    try {
      toCopy.makeCopy(name, dest);
      copiedThisRun++;
    } catch (e) {
      errors.push(name + ' (' + e.message + ')');
    }
  }

  const folders = source.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    const subDest = getOrCreateChildFolder_(dest, sub.getName());
    if (!copyFolder_(sub, subDest, visited)) return false;
  }

  for (const s of shortcutFolders) {
    const subDest = getOrCreateChildFolder_(dest, s.name);
    if (!copyFolder_(s.folder, subDest, visited)) return false;
  }
  return true;
}

// ---------- Preview and verify ----------------------------------------------

/** Dry run: what startCopy would do. Changes nothing. */
function previewCopy() {
  loadSettings_();
  checkSettings_();
  const source = DriveApp.getFolderById(cfg.sourceFolderId);
  const dest = findDestFolder_();  // null if nothing was copied yet
  const r = newReport_();
  compare_(source, dest, '', r, new Set());

  const toCopy = r.missing.reduce((n, m) => n + m.count, 0);
  const report = [
    'PREVIEW - nothing was copied or changed.',
    '',
    'Source: ' + r.srcFiles + ' files (' + gb_(r.srcBytes) + ') in ' + r.srcFolders + ' folders',
    'Already copied: ' + (r.srcFiles - toCopy),
    'Would copy now: ' + toCopy,
    '',
    ...shortcutSection_(r),
    '',
    ...unsupportedSection_(r),
  ].join('\n');

  Logger.log(report);
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Drive copy preview', report);
  return report;
}

function verifyCopy() {
  loadSettings_();
  checkSettings_();
  const source = DriveApp.getFolderById(cfg.sourceFolderId);
  const dest = findDestFolder_();
  if (!dest) throw new Error('Destination folder not found: ' + cfg.destFolderName);

  const r = newReport_();
  compare_(source, dest, '', r, new Set());

  const report = [
    'Source files: ' + r.srcFiles + '  (' + gb_(r.srcBytes) + ')',
    'Copied files: ' + r.dstFiles + '  (' + gb_(r.dstBytes) + ')',
    '',
    'Missing folders (' + r.missingFolders.length + '):',
    ...r.missingFolders,
    '',
    'Missing files (' + r.missing.length + '):',
    ...r.missing.map(m => m.path + (m.count > 1 ? '  (x' + m.count + ')' : '') + (m.note ? '  - ' + m.note : '')),
    '',
    ...shortcutSection_(r),
  ].join('\n');

  Logger.log(report);
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Drive copy check', report);
  return report;
}

function newReport_() {
  return { missing: [], missingFolders: [], shortcuts: [], unsupported: [],
           srcFiles: 0, srcFolders: 0, dstFiles: 0, dstBytes: 0, srcBytes: 0 };
}

function compare_(src, dst, path, r, visited) {
  if (visited.has(src.getId())) return;
  visited.add(src.getId());

  const dstCounts = {};
  if (dst) {
    const df = dst.getFiles();
    while (df.hasNext()) {
      const f = df.next();
      dstCounts[f.getName()] = (dstCounts[f.getName()] || 0) + 1;
      r.dstFiles++;
      r.dstBytes += f.getSize();
    }
  }

  const srcCounts = {};
  const notes = {};
  const shortcutFolders = [];
  const sf = src.getFiles();
  while (sf.hasNext()) {
    let f = sf.next();
    const name = f.getName();

    if (f.getMimeType() === SHORTCUT_MIME) {
      r.shortcuts.push(path + name + '  ->  ' + describeTarget_(f));
      if (cfg.followShortcuts) {
        const t = resolveShortcut_(f);
        if (!t) continue;
        if (t.folder) { shortcutFolders.push({ name: name, folder: t.folder }); continue; }
        f = t.file;
      }
    }

    const kind = UNSUPPORTED_MIMES[f.getMimeType()];
    if (kind) {
      r.unsupported.push(path + name + '  (' + kind + ')');
      notes[name] = kind + ', copy it by hand';
    }

    srcCounts[name] = (srcCounts[name] || 0) + 1;
    r.srcFiles++;
    r.srcBytes += f.getSize();
  }

  for (const name in srcCounts) {
    const diff = srcCounts[name] - (dstCounts[name] || 0);
    if (diff > 0) r.missing.push({ path: path + name, count: diff, note: notes[name] });
  }

  const subs = [];
  const it = src.getFolders();
  while (it.hasNext()) { const s = it.next(); subs.push({ name: s.getName(), folder: s }); }

  for (const s of subs.concat(shortcutFolders)) {
    r.srcFolders++;
    let d = null;
    if (dst) {
      const di = dst.getFoldersByName(s.name);
      if (di.hasNext()) d = di.next();
    }
    if (!d && dst) r.missingFolders.push(path + s.name + '/');
    compare_(s.folder, d, path + s.name + '/', r, visited);
  }
}

function shortcutSection_(r) {
  const how = cfg.followShortcuts
    ? 'their contents ARE copied (follow shortcuts is on)'
    : 'only the link is copied, NOT the contents (follow shortcuts is off)';
  return ['Shortcuts (' + r.shortcuts.length + ') - ' + how + ':', ...r.shortcuts];
}

function unsupportedSection_(r) {
  return ['Can\'t be copied by script (' + r.unsupported.length + ') - copy these by hand:',
          ...r.unsupported];
}

// ---------- Delete originals (run in the SOURCE account) --------------------

/**
 * Moves the files and folders THIS account owns inside the source folder to
 * the Bin. Files owned by anyone else are left alone. Shortcuts are not
 * followed. Nothing is deleted permanently: empty the Bin yourself afterwards.
 *
 * @param {boolean=} confirmed  true from the web page after the user confirmed.
 *     When run from the editor this is not set and CONFIRM_DELETE decides.
 */
function deleteOriginals(confirmed) {
  loadSettings_();
  checkSettings_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'Another run is already in progress. Wait a few minutes and check again.';
  try { return deleteOriginalsLocked_(confirmed); } finally { lock.releaseLock(); }
}

function deleteOriginalsLocked_(confirmed) {
  const p = props_();
  const continuing = typeof confirmed === 'object' && confirmed !== null;  // trigger event
  confirmDelete = CONFIRM_DELETE || confirmed === true ||
                  (continuing && p.getProperty('deleteConfirmed') === '1');
  startTime = Date.now();
  deleteTriggers_('deleteOriginals');

  const me = Session.getActiveUser().getEmail();
  const root = DriveApp.getFolderById(cfg.sourceFolderId);
  if (root.getName() === cfg.destFolderName) {
    throw new Error('The source folder setting points to the copy folder. Use the original folder.');
  }
  if (confirmDelete) setProps_({ deleteStatus: 'deleting', deleteLastRun: new Date().toISOString() });

  const r = { files: 0, bytes: 0, folders: 0, notOwned: 0, errors: [] };
  const finished = trashOwned_(root, me, r);

  const verb = confirmDelete ? 'Moved to Bin' : 'Would move to Bin';
  const lines = [
    confirmDelete ? 'Account: ' + me : 'DRY RUN - nothing was changed. Account: ' + me,
    '',
    verb + ': ' + r.files + ' files (' + gb_(r.bytes) + '), ' + r.folders + ' empty folders',
    'Left alone (owned by someone else): ' + r.notOwned,
  ];
  if (r.errors.length) lines.push('', 'Errors (' + r.errors.length + '):', ...r.errors);

  if (!finished) {
    if (confirmDelete) {
      p.setProperty('deleteConfirmed', '1');
      ScriptApp.newTrigger('deleteOriginals').timeBased().after(60 * 1000).create();
      lines.push('', 'Time limit reached - continuing automatically in about 1 minute.');
    } else {
      lines.push('', 'Time limit reached - the dry run covers only part of the folder.');
    }
    const partial = lines.join('\n');
    Logger.log(partial);
    return partial;
  }

  p.deleteProperty('deleteConfirmed');
  if (confirmDelete) {
    setProps_({ deleteStatus: 'done' });
    const elsewhere = countOwnedFiles_(1000);
    lines.push('',
      'Files this account still owns elsewhere in Drive: ' + elsewhere.count +
        (elsewhere.capped ? '+' : '') + (elsewhere.count ? ' (search owner:me in Drive to see them)' : ''),
      '',
      'Last step: open Drive > Bin > Empty bin. Space is freed only after that (permanent).');
  } else {
    lines.push('', 'To do it for real, confirm the delete (on the web page) or set ' +
               'CONFIRM_DELETE = true, save, and run deleteOriginals again.');
  }

  const report = lines.join('\n');
  Logger.log(report);
  MailApp.sendEmail(me, confirmDelete ? 'Drive originals moved to Bin' : 'Drive delete preview', report);
  return report;
}

/** Returns true when done, false if it ran out of time. */
function trashOwned_(folder, me, r) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) return false;
    const f = files.next();
    if (f.isTrashed()) continue;  // already done in an earlier run
    if (ownerOf_(f) !== me) { r.notOwned++; continue; }
    r.files++;
    r.bytes += f.getSize();
    if (confirmDelete) {
      try { f.setTrashed(true); } catch (e) { r.errors.push(f.getName() + ' (' + e.message + ')'); }
    }
  }

  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    if (sub.isTrashed()) continue;
    if (!trashOwned_(sub, me, r)) return false;
  }

  // Bin the folder itself once it is empty (or would be, in a dry run).
  if (ownerOf_(folder) === me) {
    const empty = !hasLiveItem_(folder.getFiles()) && !hasLiveItem_(folder.getFolders());
    if (!confirmDelete || empty) {
      r.folders++;
      if (confirmDelete) {
        try { folder.setTrashed(true); } catch (e) { r.errors.push(folder.getName() + '/ (' + e.message + ')'); }
      }
    }
  }
  return true;
}

function hasLiveItem_(iterator) {
  while (iterator.hasNext()) {
    if (!iterator.next().isTrashed()) return true;
  }
  return false;
}

function countOwnedFiles_(limit) {
  const it = DriveApp.searchFiles("'me' in owners and trashed = false");
  let count = 0;
  while (it.hasNext() && count < limit) { it.next(); count++; }
  return { count: count, capped: it.hasNext() };
}

// ---------- Helpers ---------------------------------------------------------

function props_() {
  return PropertiesService.getScriptProperties();
}

function setProps_(o) {
  props_().setProperties(o);
}

/** Settings saved from the web page win over the constants at the top. */
function loadSettings_() {
  const p = props_().getProperties();
  cfg = {
    sourceFolderId: p.sourceFolderId || SOURCE_FOLDER_ID,
    destFolderName: p.destFolderName || DEST_FOLDER_NAME,
    followShortcuts: p.followShortcuts !== undefined ? p.followShortcuts === '1' : FOLLOW_SHORTCUTS,
  };
  return cfg;
}

function checkSettings_() {
  if (!cfg.sourceFolderId || cfg.sourceFolderId === 'PASTE_FOLDER_ID_HERE') {
    throw new Error('Set the source folder first (on the web page, or SOURCE_FOLDER_ID at the top of the script).');
  }
}

/** Accepts a folder link or a bare ID. */
function extractId_(text) {
  const s = String(text).trim();
  const m = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : '';
}

function folderName_(id) {
  try { return DriveApp.getFolderById(id).getName(); } catch (e) { return ''; }
}

function folderOwner_(id) {
  try { return ownerOf_(DriveApp.getFolderById(id)); } catch (e) { return ''; }
}

function findDestFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(cfg.destFolderName);
  return it.hasNext() ? it.next() : null;
}

function resolveShortcut_(shortcut) {
  try {
    const id = shortcut.getTargetId();
    return shortcut.getTargetMimeType() === FOLDER_MIME
      ? { folder: DriveApp.getFolderById(id) }
      : { file: DriveApp.getFileById(id) };
  } catch (e) {
    return null;
  }
}

function describeTarget_(shortcut) {
  const t = resolveShortcut_(shortcut);
  if (!t) return 'target not accessible';
  const item = t.folder || t.file;
  return (t.folder ? 'folder' : 'file') + ' "' + item.getName() + '", owner ' + ownerOf_(item);
}

function ownerOf_(item) {
  try { return item.getOwner().getEmail(); } catch (e) { return 'unknown'; }
}

function gb_(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function getOrCreateChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}
