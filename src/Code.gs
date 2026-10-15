/**
 * Google Drive Mover
 * ------------------
 * Copies everything inside a folder shared FROM another Google account into
 * THIS account's Drive, so the copies use this account's storage. Then
 * checks that nothing was missed.
 *
 * Run it in the DESTINATION account (the one that should receive the files).
 * See README.md for the full step-by-step guide.
 *
 *   startCopy()   - copies the folder. Continues by itself every few minutes
 *                   (Apps Script stops each run after ~6 minutes) and emails
 *                   you when it is finished. Safe to run again: files that
 *                   were already copied are skipped.
 *   verifyCopy()  - compares source and copy and emails a report of missing
 *                   files, missing folders and shortcuts.
 *   stopCopy()    - cancels the automatic continuation.
 */

// ===== Settings =============================================================

// ID of the folder shared from the source account. It is the part of the
// folder's address after /folders/
const SOURCE_FOLDER_ID = 'PASTE_FOLDER_ID_HERE';

// Name of the folder that is created in My Drive of THIS account.
const DEST_FOLDER_NAME = 'Copied from old account';

// ============================================================================

const MAX_RUNTIME_MS = 5 * 60 * 1000;  // stop before Google's 6-minute limit
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

let startTime;
let copiedThisRun = 0;
let errors = [];

// ---------- Copy ------------------------------------------------------------

function startCopy() {
  checkSettings_();
  startTime = Date.now();
  deleteContinuationTriggers_();

  const source = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const dest = getOrCreateChildFolder_(DriveApp.getRootFolder(), DEST_FOLDER_NAME);

  const finished = copyFolder_(source, dest);

  Logger.log('Copied this run: ' + copiedThisRun);
  if (errors.length) Logger.log('Could not copy:\n' + errors.join('\n'));

  if (finished) {
    MailApp.sendEmail(
      Session.getActiveUser().getEmail(),
      'Drive copy finished',
      'All files were copied into "' + DEST_FOLDER_NAME + '".\n\n' +
      (errors.length ? 'These could not be copied:\n' + errors.join('\n') : 'No errors.') +
      '\n\nNext step: run verifyCopy to check that nothing is missing.'
    );
    Logger.log('All done.');
  } else {
    ScriptApp.newTrigger('startCopy').timeBased().after(60 * 1000).create();
    Logger.log('Time limit reached - continuing automatically in about 1 minute.');
  }
}

function stopCopy() {
  deleteContinuationTriggers_();
  Logger.log('Automatic continuation cancelled.');
}

/** Returns true when the folder is fully copied, false if it ran out of time. */
function copyFolder_(source, dest) {
  // Count what already exists in the destination, so re-runs skip finished
  // files (and files that share a name are still all copied).
  const existing = {};
  const destFiles = dest.getFiles();
  while (destFiles.hasNext()) {
    const n = destFiles.next().getName();
    existing[n] = (existing[n] || 0) + 1;
  }

  const seen = {};
  const files = source.getFiles();
  while (files.hasNext()) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) return false;
    const file = files.next();
    const name = file.getName();
    seen[name] = (seen[name] || 0) + 1;
    if ((existing[name] || 0) >= seen[name]) continue; // already copied

    try {
      file.makeCopy(name, dest);
      copiedThisRun++;
    } catch (e) {
      errors.push(name + ' (' + e.message + ')');
    }
  }

  const folders = source.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    const subDest = getOrCreateChildFolder_(dest, sub.getName());
    if (!copyFolder_(sub, subDest)) return false;
  }
  return true;
}

// ---------- Verify ----------------------------------------------------------

function verifyCopy() {
  checkSettings_();
  const source = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const destIt = DriveApp.getRootFolder().getFoldersByName(DEST_FOLDER_NAME);
  if (!destIt.hasNext()) throw new Error('Destination folder not found: ' + DEST_FOLDER_NAME);
  const dest = destIt.next();

  const r = { missing: [], missingFolders: [], shortcuts: [],
              srcFiles: 0, dstFiles: 0, srcBytes: 0, dstBytes: 0 };
  compare_(source, dest, '', r);

  const gb = b => (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  const report = [
    'Source files: ' + r.srcFiles + '  (' + gb(r.srcBytes) + ')',
    'Copied files: ' + r.dstFiles + '  (' + gb(r.dstBytes) + ')',
    '',
    'Missing folders (' + r.missingFolders.length + '):',
    ...r.missingFolders,
    '',
    'Missing files (' + r.missing.length + '):',
    ...r.missing,
    '',
    'Shortcuts (' + r.shortcuts.length + ') - only the link was copied, NOT the content it points to.',
    'Check who owns each target before deleting anything in the source account:',
    ...r.shortcuts,
  ].join('\n');

  Logger.log(report);
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Drive copy check', report);
}

function compare_(src, dst, path, r) {
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
  const sf = src.getFiles();
  while (sf.hasNext()) {
    const f = sf.next();
    const name = f.getName();
    srcCounts[name] = (srcCounts[name] || 0) + 1;
    r.srcFiles++;
    r.srcBytes += f.getSize();
    if (f.getMimeType() === SHORTCUT_MIME) {
      r.shortcuts.push(path + name + '  ->  ' + describeTarget_(f));
    }
  }

  for (const name in srcCounts) {
    const diff = srcCounts[name] - (dstCounts[name] || 0);
    if (diff > 0) r.missing.push(path + name + (diff > 1 ? '  (x' + diff + ')' : ''));
  }

  const sub = src.getFolders();
  while (sub.hasNext()) {
    const s = sub.next();
    let d = null;
    if (dst) {
      const it = dst.getFoldersByName(s.getName());
      if (it.hasNext()) d = it.next();
    }
    if (!d) r.missingFolders.push(path + s.getName() + '/');
    compare_(s, d, path + s.getName() + '/', r);
  }
}

function describeTarget_(shortcut) {
  try {
    const id = shortcut.getTargetId();
    const isFolder = shortcut.getTargetMimeType() === 'application/vnd.google-apps.folder';
    const target = isFolder ? DriveApp.getFolderById(id) : DriveApp.getFileById(id);
    let owner = 'unknown owner';
    try { owner = target.getOwner().getEmail(); } catch (e) {}
    return (isFolder ? 'folder' : 'file') + ' "' + target.getName() + '", owner ' + owner + ' (id ' + id + ')';
  } catch (e) {
    return 'target not accessible';
  }
}

// ---------- Helpers ---------------------------------------------------------

function checkSettings_() {
  if (!SOURCE_FOLDER_ID || SOURCE_FOLDER_ID === 'PASTE_FOLDER_ID_HERE') {
    throw new Error('Set SOURCE_FOLDER_ID at the top of the script first.');
  }
}

function getOrCreateChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'startCopy')
    .forEach(t => ScriptApp.deleteTrigger(t));
}
