/**
 * Google Drive Mover
 * ------------------
 * Moves everything inside a folder shared FROM one Google account into
 * another account's Drive, so the files use the other account's storage.
 * See README.md for the full step-by-step guide.
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

// ID of the folder shared from the source account. It is the part of the
// folder's address after /folders/
const SOURCE_FOLDER_ID = 'PASTE_FOLDER_ID_HERE';

// Name of the folder that is created in My Drive of the destination account.
const DEST_FOLDER_NAME = 'Copied from old account';

// true:  copy what a shortcut points to (a folder's contents, or the file).
// false: copy only the shortcut itself (a link).
const FOLLOW_SHORTCUTS = true;

// Used by deleteOriginals() only. Leave false for a dry run that lists what
// would be moved to the Bin. Set to true only after verifyCopy looks right.
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

let startTime;
let copiedThisRun = 0;
let errors = [];

// ---------- Copy ------------------------------------------------------------

function startCopy() {
  checkSettings_();
  startTime = Date.now();
  copiedThisRun = 0;
  errors = [];
  deleteTriggers_('startCopy');

  const source = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const dest = getOrCreateChildFolder_(DriveApp.getRootFolder(), DEST_FOLDER_NAME);

  const finished = copyFolder_(source, dest, new Set());

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
  deleteTriggers_('startCopy');
  deleteTriggers_('deleteOriginals');
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
    if (FOLLOW_SHORTCUTS && file.getMimeType() === SHORTCUT_MIME) {
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
  checkSettings_();
  const source = DriveApp.getFolderById(SOURCE_FOLDER_ID);
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
}

function verifyCopy() {
  checkSettings_();
  const source = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const dest = findDestFolder_();
  if (!dest) throw new Error('Destination folder not found: ' + DEST_FOLDER_NAME);

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
      if (FOLLOW_SHORTCUTS) {
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
  const how = FOLLOW_SHORTCUTS
    ? 'their contents ARE copied (FOLLOW_SHORTCUTS = true)'
    : 'only the link is copied, NOT the contents (FOLLOW_SHORTCUTS = false)';
  return ['Shortcuts (' + r.shortcuts.length + ') - ' + how + ':', ...r.shortcuts];
}

function unsupportedSection_(r) {
  return ['Can\'t be copied by script (' + r.unsupported.length + ') - copy these by hand:',
          ...r.unsupported];
}

// ---------- Delete originals (run in the SOURCE account) --------------------

/**
 * Moves the files and folders THIS account owns inside SOURCE_FOLDER_ID to
 * the Bin. Files owned by anyone else are left alone. Shortcuts are not
 * followed. Nothing is deleted permanently: empty the Bin yourself afterwards.
 */
function deleteOriginals() {
  checkSettings_();
  startTime = Date.now();
  deleteTriggers_('deleteOriginals');

  const me = Session.getActiveUser().getEmail();
  const root = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  if (root.getName() === DEST_FOLDER_NAME) {
    throw new Error('SOURCE_FOLDER_ID points to the copy folder. Use the original folder.');
  }

  const r = { files: 0, bytes: 0, folders: 0, notOwned: 0, errors: [] };
  const finished = trashOwned_(root, me, r);

  const verb = CONFIRM_DELETE ? 'Moved to Bin' : 'Would move to Bin';
  const lines = [
    CONFIRM_DELETE ? 'Account: ' + me : 'DRY RUN - nothing was changed. Account: ' + me,
    '',
    verb + ': ' + r.files + ' files (' + gb_(r.bytes) + '), ' + r.folders + ' empty folders',
    'Left alone (owned by someone else): ' + r.notOwned,
  ];
  if (r.errors.length) lines.push('', 'Errors (' + r.errors.length + '):', ...r.errors);

  if (!finished) {
    if (CONFIRM_DELETE) {
      ScriptApp.newTrigger('deleteOriginals').timeBased().after(60 * 1000).create();
      Logger.log(lines.join('\n') + '\n\nTime limit reached - continuing automatically in about 1 minute.');
    } else {
      Logger.log(lines.join('\n') + '\n\nTime limit reached - the dry run covers only part of the folder.');
    }
    return;
  }

  if (CONFIRM_DELETE) {
    const elsewhere = countOwnedFiles_(1000);
    lines.push('',
      'Files this account still owns elsewhere in Drive: ' + elsewhere.count +
        (elsewhere.capped ? '+' : '') + (elsewhere.count ? ' (search owner:me in Drive to see them)' : ''),
      '',
      'Last step: open Drive > Bin > Empty bin. Space is freed only after that (permanent).');
  } else {
    lines.push('', 'To do it for real: set CONFIRM_DELETE = true, save, and run deleteOriginals again.');
  }

  const report = lines.join('\n');
  Logger.log(report);
  MailApp.sendEmail(me, CONFIRM_DELETE ? 'Drive originals moved to Bin' : 'Drive delete preview', report);
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
    if (CONFIRM_DELETE) {
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
    if (!CONFIRM_DELETE || empty) {
      r.folders++;
      if (CONFIRM_DELETE) {
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

function checkSettings_() {
  if (!SOURCE_FOLDER_ID || SOURCE_FOLDER_ID === 'PASTE_FOLDER_ID_HERE') {
    throw new Error('Set SOURCE_FOLDER_ID at the top of the script first.');
  }
}

function findDestFolder_() {
  const it = DriveApp.getRootFolder().getFoldersByName(DEST_FOLDER_NAME);
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
