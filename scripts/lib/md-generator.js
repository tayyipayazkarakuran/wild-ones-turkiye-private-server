const path = require('path');

function escapeMD(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function tableHeader(cols) {
  return `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n`;
}

function tableRow(cols) {
  return `| ${cols.map(c => escapeMD(c)).join(' | ')} |\n`;
}

function codeBlock(code, lang = '') {
  return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

function link(text, filePath) {
  return `[\`${text}\`](${filePath})`;
}

function badgify(label, value, color = 'blue') {
  return `![${label}](https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(String(value))}-${color})`;
}

function generateDirMD(dirPath, files, projectRoot) {
  const dirName = dirPath || '.';
  const folderLabel = dirName.split('/').pop();
  const isRoot = dirPath === '.';

  const lines = [];
  const name = isRoot ? 'Project Root' : `\`${dirName}/\``;
  lines.push(`# ${name}\n`);
  lines.push(`**${files.length} file(s)**\n`);

  const jsFiles = files.filter(f => f.ext === '.js');
  const swfFiles = files.filter(f => f.ext === '.swf');
  const dataFiles = files.filter(f => f.ext !== '.js' && f.ext !== '.swf');

  if (jsFiles.length > 0) {
    lines.push('## JavaScript Files\n');
    lines.push(tableHeader(['File', 'Lines', 'Size', 'Classes', 'Functions', 'Requires', 'Commands']));
    for (const f of jsFiles) {
      if (!f.analysis) continue;
      const a = f.analysis;
      const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
      lines.push(tableRow([
        link(f.name, relPath),
        String(a.lineCount),
        `${(a.size / 1024).toFixed(1)} KB`,
        a.classes.join(', ') || '-',
        String(a.functions.length),
        String(a.requires.length),
        a.commands.slice(0, 5).join(', ') + (a.commands.length > 5 ? '...' : '') || '-'
      ]));
    }
  }

  if (swfFiles.length > 0) {
    lines.push('## SWF Files\n');
    lines.push(tableHeader(['File', 'Size', 'SWF Version', 'Compressed', 'Frame Rate', 'Frames', 'Classes Found']));
    for (const f of swfFiles) {
      if (!f.analysis || f.analysis.error) {
        const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
        lines.push(tableRow([link(f.name, relPath), `${(f.size / 1024).toFixed(1)} KB`, 'Error', '-', '-', '-', '-']));
        continue;
      }
      const a = f.analysis;
      const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
      lines.push(tableRow([
        link(f.name, relPath),
        `${(a.size / 1024).toFixed(1)} KB`,
        String(a.version),
        a.compressed ? 'Yes (CWS)' : 'No (FWS)',
        String(a.frameRate),
        String(a.frameCount),
        String(a.classes ? a.classes.length : 0)
      ]));
    }
  }

  if (dataFiles.length > 0) {
    lines.push('## Other Files\n');
    lines.push(tableHeader(['File', 'Size', 'Type']));
    for (const f of dataFiles) {
      const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
      const typeLabel = f.ext === '.json' ? 'JSON Config' :
                        f.ext === '.html' ? 'HTML Page' :
                        f.ext === '.png' ? 'Image (PNG)' :
                        f.ext === '.gif' ? 'Image (GIF)' :
                        f.ext === '.mp3' ? 'Audio (MP3)' :
                        f.ext === '.dat' ? 'Game Data' : f.ext.toUpperCase();
      lines.push(tableRow([link(f.name, relPath), `${(f.size / 1024).toFixed(1)} KB`, typeLabel]));
    }
  }

  if (jsFiles.length > 0 || swfFiles.length > 0) {
    lines.push('\n## Detailed File Descriptions\n');
    for (const f of jsFiles) {
      if (!f.analysis) continue;
      const a = f.analysis;
      const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
      lines.push(`### ${link(f.name, relPath)}\n`);
      if (a.description) lines.push(`${a.description}\n`);
      lines.push(`- **Lines**: ${a.lineCount} | **Size**: ${(a.size / 1024).toFixed(1)} KB`);

      if (a.requires.length > 0) {
        lines.push(`- **Dependencies**: ${a.requires.map(r => `\`${r}\``).join(', ')}`);
      }
      if (a.classes.length > 0) {
        lines.push(`- **Classes**: ${a.classes.map(c => `\`${c}\``).join(', ')}`);
      }
      if (a.functions.length > 0) {
        lines.push(`- **Key Methods**: ${a.functions.filter(fn => !fn.includes('.prototype.')).slice(0, 10).map(f => `\`${f}()\``).join(', ')}`);
      }
      if (a.commands.length > 0) {
        lines.push(`- **Protocol Commands**: ${a.commands.map(c => `\`${c}\``).join(', ')}`);
      }
      if (a.ports.length > 0) {
        lines.push(`- **Port(s)**: ${a.ports.join(', ')}`);
      }
      if (a.dbOps.length > 0) {
        lines.push(`- **DB Operations**: ${a.dbOps.length} reference(s)`);
      }
      lines.push('');
    }

    for (const f of swfFiles) {
      if (!f.analysis || f.analysis.error) {
        const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
        lines.push(`### ${link(f.name, relPath)}\n`);
        lines.push(`- **Analysis Error**: ${f.analysis ? f.analysis.error : 'Unknown'}\n`);
        continue;
      }
      const a = f.analysis;
      const relPath = path.relative(projectRoot, f.path).replace(/\\/g, '/');
      lines.push(`### ${link(f.name, relPath)}\n`);
      lines.push(`- **SWF Version**: ${a.version} | **Size**: ${(a.size / 1024).toFixed(1)} KB (decompressed: ${((a.decompressedSize||0) / 1024).toFixed(1)} KB)`);
      lines.push(`- **Compression**: ${a.compressed ? 'Zlib compressed (CWS)' : 'Uncompressed (FWS)'}`);
      lines.push(`- **Frame Rate**: ${a.frameRate || '?'} fps | **Frames**: ${a.frameCount || '?'}`);
      if (a.fileAttributes) {
        const fa = a.fileAttributes;
        lines.push(`- **File Attributes**: AS3=${fa.actionScript3}, GPU=${fa.useGPU}, Network=${fa.SWFUsedForNetwork}`);
      }
      if (a.commands && a.commands.length > 0) {
        lines.push(`- **Protocol Commands Found**: ${a.commands.slice(0, 20).map(c => `\`${c}\``).join(', ')}`);
      }
      if (a.classes && a.classes.length > 0) {
        lines.push(`- **Classes/Namespaces Found**: ${a.classes.slice(0, 20).map(c => `\`${c}\``).join(', ')}`);
      }
      if (a.networkUrls && a.networkUrls.length > 0) {
        lines.push(`- **Network URLs**: ${a.networkUrls.slice(0, 10).map(u => `\`${u}\``).join(', ')}`);
      }
      if (a.tags && a.tags.length > 0) {
        lines.push(`- **Top Tags**: ${a.tags.slice(0, 8).map(t => `${t.name}(${t.count})`).join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateManifestMD(allFiles, projectRoot) {
  const lines = [];
  lines.push('# Complete File Manifest\n');
  lines.push(`Total files: ${allFiles.length}\n`);
  lines.push(tableHeader(['#', 'File', 'Type', 'Size', 'Directory']));

  let idx = 1;
  for (const f of allFiles) {
    const relPath = f.relPath;
    const typeLabel = f.ext === '.js' ? 'JS' :
                      f.ext === '.swf' ? 'SWF' :
                      f.ext === '.json' ? 'JSON' :
                      f.ext === '.html' ? 'HTML' :
                      f.ext === '.dat' ? 'DAT' : f.ext.toUpperCase();
    lines.push(tableRow([
      String(idx++),
      link(f.name, relPath),
      typeLabel,
      `${(f.size / 1024).toFixed(1)} KB`,
      f.dir
    ]));
  }

  return lines.join('\n');
}

module.exports = { generateDirMD, generateManifestMD, tableHeader, tableRow, codeBlock, link };
