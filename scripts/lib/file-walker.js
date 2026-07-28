const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'old']);
const BINARY_EXTS = new Set(['.swf', '.png', '.gif', '.jpg', '.mp3', '.zip', '.dat']);

function walkDir(dirPath, baseDir) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, baseDir));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const stat = fs.statSync(fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        relPath: relPath.replace(/\\/g, '/'),
        ext,
        isBinary: BINARY_EXTS.has(ext),
        size: stat.size,
        dir: path.dirname(relPath).replace(/\\/g, '/')
      });
    }
  }
  return files;
}

function groupByDir(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = f.dir || '.';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return groups;
}

function getTopLevelDirs(baseDir) {
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name)) {
      dirs.push(e.name);
    }
  }
  return dirs;
}

module.exports = { walkDir, groupByDir, getTopLevelDirs, IGNORE_DIRS, BINARY_EXTS };
