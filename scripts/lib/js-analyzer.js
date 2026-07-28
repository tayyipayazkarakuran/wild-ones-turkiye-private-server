const fs = require('fs');

function analyzeJS(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const info = {
    requires: [],
    exports: [],
    classes: [],
    functions: [],
    keyConstants: [],
    commands: [],
    protocols: [],
    ports: [],
    dbOps: [],
    lineCount: lines.length,
    size: content.length,
    hasStrict: content.includes('"use strict"') || content.includes("'use strict'"),
    hasEventEmitter: false,
    hasSocket: false,
    hasHttp: false,
    hasTimer: false,
    description: extractDescription(lines)
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const reqMatch = trimmed.match(/(?:var|const|let)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (reqMatch) info.requires.push(reqMatch[1]);

    const expMatch = trimmed.match(/module\.exports\s*=\s*(\w+)/);
    if (expMatch) info.exports.push(expMatch[1]);

    const expMatch2 = trimmed.match(/exports\.(\w+)\s*=/);
    if (expMatch2) info.exports.push(expMatch2[1]);

    const classMatch = trimmed.match(/class\s+(\w+)/);
    if (classMatch) info.classes.push(classMatch[1]);

    const funcMatch = trimmed.match(/(?:function\s+(\w+)|(\w+)\s*=\s*function\s*\()/);
    if (funcMatch) {
      const name = funcMatch[1] || funcMatch[2];
      if (name && name !== 'function') info.functions.push(name);
    }

    const protoMatch = trimmed.match(/(\w+)\.prototype\.(\w+)\s*=\s*function/);
    if (protoMatch) {
      const fullName = `${protoMatch[1]}.prototype.${protoMatch[2]}`;
      info.functions.push(fullName);
    }

    if (trimmed.includes('require("net")') || trimmed.includes("require('net')")) info.hasSocket = true;
    if (trimmed.includes('require("http")') || trimmed.includes("require('http')")) info.hasHttp = true;
    if (trimmed.includes('EventEmitter')) info.hasEventEmitter = true;
    if (trimmed.includes('setInterval') || trimmed.includes('setTimeout')) info.hasTimer = true;

    const cmdMatch = trimmed.match(/["']command["']\s*:\s*["'](\w+)["']/);
    if (cmdMatch && !info.commands.includes(cmdMatch[1])) info.commands.push(cmdMatch[1]);

    const cmdMatch2 = trimmed.match(/command["']?\s*[=:]\s*["'](\w+)["']/);
    if (cmdMatch2 && !info.commands.includes(cmdMatch2[1])) info.commands.push(cmdMatch2[1]);

    const caseMatch = trimmed.match(/case\s+["'](\w+)["']\s*:/);
    if (caseMatch && !info.commands.includes(caseMatch[1])) info.commands.push(caseMatch[1]);

    const handleMatch = trimmed.match(/handle(\w+)Command/);
    if (handleMatch && !info.commands.includes(handleMatch[1])) info.commands.push(handleMatch[1]);

    const portMatch = trimmed.match(/port\s*[:=]\s*(\d{2,5})/);
    if (portMatch && !info.ports.includes(portMatch[1])) info.ports.push(portMatch[1]);

    const portMatch2 = trimmed.match(/listen\(\s*(\d{2,5})/);
    if (portMatch2 && !info.ports.includes(portMatch2[1])) info.ports.push(portMatch2[1]);

    if (trimmed.includes('update(') || trimmed.includes('find(') || trimmed.includes('insert(') || trimmed.includes('count(')) {
      if (trimmed.includes('db') || trimmed.includes('collection')) {
        info.dbOps.push(trimmed.substring(0, 80));
      }
    }
  }

  info.requires = [...new Set(info.requires)];
  info.exports = [...new Set(info.exports)];
  info.classes = [...new Set(info.classes)];
  info.functions = [...new Set(info.functions)];
  info.commands = [...new Set(info.commands)];
  info.ports = [...new Set(info.ports)];

  return info;
}

function extractDescription(lines) {
  const commentLines = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('/**')) { inBlock = true; continue; }
    if (inBlock) {
      if (trimmed.startsWith('*/')) break;
      const cleaned = trimmed.replace(/^\s*\*\s?/, '');
      if (cleaned) commentLines.push(cleaned);
    }
  }
  if (commentLines.length > 0) return commentLines.join(' ');
  for (const line of lines.slice(0, 10)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      commentLines.push(trimmed.replace(/^\/\/\s?/, ''));
    }
  }
  return commentLines.slice(0, 3).join(' ');
}

module.exports = { analyzeJS };
