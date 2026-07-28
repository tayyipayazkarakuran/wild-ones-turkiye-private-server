const fs = require('fs');
const zlib = require('zlib');

function parseSWF(filePath) {
  const buf = fs.readFileSync(filePath);
  const info = {
    path: filePath,
    size: buf.length,
    signature: null,
    version: null,
    fileSize: null,
    compressed: false,
    frameRate: null,
    frameCount: null,
    frameSize: null,
    strings: [],
    classes: [],
    networkUrls: [],
    commands: [],
    tags: [],
    error: null
  };

  if (buf.length < 8) {
    info.error = 'File too small to be SWF';
    return info;
  }

  const sig = buf.slice(0, 3).toString('ascii');
  info.signature = sig;
  info.version = buf.readUInt8(3);
  info.fileSize = buf.readUInt32LE(4);

  if (sig === 'CWS' || sig === 'ZWS') {
    info.compressed = true;
  } else if (sig !== 'FWS') {
    info.error = `Unknown SWF signature: ${sig}`;
    return info;
  }

  let decompressed = null;
  if (info.compressed) {
    try {
      const compressed = buf.slice(8);
      decompressed = zlib.inflateSync(compressed);
    } catch (e) {
      try {
        const compressed = buf.slice(8);
        decompressed = zlib.unzipSync(compressed);
      } catch (e2) {
        info.error = `Failed to decompress: ${e2.message}`;
        return info;
      }
    }
  } else {
    decompressed = buf.slice(8);
  }

  info.decompressedSize = decompressed.length;

  let offset = 0;
  const nbits = decompressed[offset] >> 3;
  const rectLen = Math.ceil((5 + 4 * nbits) / 8);
  info.frameSize = rectLen > 0 ? decompressed.slice(offset, offset + rectLen).toString('hex') : 'N/A';
  offset += rectLen;

  info.frameRate = decompressed.readUInt16LE(offset);
  offset += 2;
  info.frameCount = decompressed.readUInt16LE(offset);
  offset += 2;

  const tagTypes = {};
  while (offset < decompressed.length - 2) {
    const tagHeader = decompressed.readUInt16LE(offset);
    const tagType = tagHeader >> 6;
    let tagLen = tagHeader & 0x3f;
    offset += 2;
    if (tagLen === 0x3f) {
      tagLen = decompressed.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + tagLen > decompressed.length) break;

    const tagData = decompressed.slice(offset, offset + tagLen);

    let tagName = getTagName(tagType);
    tagTypes[tagType] = (tagTypes[tagType] || 0) + 1;

    if (tagType === 69) {
      extractFileAttributes(tagData, info);
    }

    if (tagType === 76 || tagType === 77) {
      extractSymbolClass(tagData, info);
    }

    if (tagType === 82 || tagType === 83) {
      extractDoABC(tagData, info);
    }

    offset += tagLen;
  }

  info.tags = Object.entries(tagTypes)
    .map(([type, count]) => ({ type: parseInt(type), name: getTagName(parseInt(type)), count }))
    .sort((a, b) => b.count - a.count);

  extractStrings(buf, info);

  return info;
}

function extractStrings(buf, info) {
  const minLen = 4;
  let i = 0;
  while (i < buf.length - minLen) {
    if (buf[i] >= 0x20 && buf[i] <= 0x7e) {
      let j = i;
      while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x7e) j++;
      if (j - i >= minLen) {
        const str = buf.slice(i, j).toString('ascii');
        if (isRelevantString(str)) {
          if (str.startsWith('http://') || str.startsWith('https://') || str.startsWith('www.')) {
            addUnique(info.networkUrls, str);
          } else if (str.match(/^[a-z_][a-z0-9_]{0,30}$/) && str.includes('_')) {
            addUnique(info.commands, str);
          } else if (str.match(/^[A-Z][a-zA-Z0-9_]+$/) && str.length > 3) {
            addUnique(info.classes, str);
          }
        }
        info.strings.push(str);
      }
      i = j;
    } else {
      i++;
    }
  }
}

function isRelevantString(str) {
  if (str.includes('\\') || str.includes('{') || str.includes('}')) return false;
  if (/^\d+$/.test(str)) return false;
  if (str.length > 100) return false;
  return true;
}

function addUnique(arr, item) {
  if (!arr.includes(item)) arr.push(item);
}

function getTagName(type) {
  const names = {
    0: 'End', 1: 'ShowFrame', 2: 'DefineShape', 6: 'DefineBits', 7: 'DefineButton',
    8: 'JPEGTables', 9: 'SetBackgroundColor', 10: 'DefineFont', 11: 'DefineText',
    12: 'DoAction', 13: 'DefineFontInfo', 14: 'DefineSound', 15: 'StartSound',
    18: 'SoundStreamHead', 19: 'SoundStreamBlock', 20: 'DefineBitsLossless',
    21: 'DefineBitsJPEG2', 22: 'DefineShape2', 26: 'DefineShape3',
    28: 'DefineText2', 32: 'DefineShape4', 33: 'DefineMorphShape',
    34: 'DefineFont2', 36: 'DefineFont3', 37: 'DefineTextField',
    39: 'DefineFont4', 40: 'DefineButton2', 41: 'DefineBitsJPEG3',
    43: 'DefineBitsLossless2', 45: 'DefineShape5', 46: 'DefineFontName',
    48: 'DefineFont5', 56: 'ExportAssets', 57: 'ImportAssets',
    58: 'EnableDebugger', 59: 'EnableDebugger2', 60: 'ScriptLimits',
    61: 'SetTabIndex', 65: 'DefineShape6', 66: 'DefineBitsJPEG4',
    69: 'FileAttributes', 70: 'DefineFont6', 72: 'DefineFont7',
    73: 'DefineFont8', 74: 'DefineBitsJPEG5', 76: 'SymbolClass',
    77: 'Metadata', 78: 'DefineScalingGrid', 82: 'DoABC',
    83: 'DoABCDefine', 84: 'DefineShape7', 86: 'DefineSceneAndFrameLabelData',
    87: 'DefineBinaryData', 88: 'DefineFontName', 91: 'DefineShape8',
    93: 'DefineBitsJPEG6', 94: 'DefineBitsLossless3'
  };
  return names[type] || `Tag_${type}`;
}

function extractFileAttributes(data, info) {
  if (data.length >= 1) {
    const flags = data[0];
    info.fileAttributes = {
      useDirectBlit: !!(flags & 0x40),
      useGPU: !!(flags & 0x20),
      hasMetadata: !!(flags & 0x10),
      actionScript3: !!(flags & 0x08),
      suppressCrossDomainCaching: !!(flags & 0x04),
      SWFUsedForNetwork: !!(flags & 0x02)
    };
  }
}

function extractSymbolClass(data, info) {
  const numSymbols = data.readUInt16LE(0);
  let offset = 2;
  for (let i = 0; i < numSymbols && offset < data.length; i++) {
    offset += 2;
    const nameEnd = data.indexOf(0, offset);
    if (nameEnd < 0) break;
    const className = data.slice(offset, nameEnd).toString('utf8');
    if (className) addUnique(info.classes, className);
    offset = nameEnd + 1;
  }
}

function extractDoABC(data, info) {
  const flags = data.readUInt32LE(0);
  const nameEnd = data.indexOf(0, 4);
  if (nameEnd > 0) {
    const name = data.slice(4, nameEnd).toString('utf8');
    if (name) addUnique(info.classes, name);
  }
  const abcStart = nameEnd > 0 ? nameEnd + 1 : 4;
  if (abcStart < data.length) {
    extractABCStrings(data.slice(abcStart), info);
  }
}

function extractABCStrings(data, info) {
  if (data.length < 4) return;
  const version = data.readUInt16LE(0);
  if (version !== 46) return;
  let offset = 4;
  const intCount = readU30(data, offset);
  offset += intCount.length;
  offset += intCount.value * 4;

  const uintCount = readU30(data, offset);
  offset += uintCount.length;
  offset += uintCount.value * 4;

  const doubleCount = readU30(data, offset);
  offset += doubleCount.length;
  offset += doubleCount.value * 8;

  const stringCount = readU30(data, offset);
  offset += stringCount.length;

  for (let i = 0; i < stringCount.value && offset < data.length; i++) {
    const strLen = readU30(data, offset);
    offset += strLen.length;
    if (offset + strLen.value <= data.length) {
      let str = data.slice(offset, offset + strLen.value).toString('utf8');
      offset += strLen.value;
      if (str.includes('.') && str.split('.').every(s => /^[a-zA-Z0-9_$]+$/.test(s))) {
        addUnique(info.classes, str);
      }
    }
  }
}

function readU30(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = 0;
  while (offset + i < buf.length) {
    const byte = buf[offset + i];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    i++;
    if (!(byte & 0x80)) break;
  }
  return { value: result, length: i };
}

function analyzeSWF(filePath) {
  return parseSWF(filePath);
}

module.exports = { analyzeSWF, parseSWF };
