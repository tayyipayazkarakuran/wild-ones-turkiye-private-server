var Jimp = require('jimp').Jimp;
var fs = require('fs');
var path = require('path');
var Utils = require('./helpers/utils.js');

var DEBUG = process.env.DEBUG === 'true';
// Decoded, pristine masks shared by every room in this process.
var decodedMasks = new Map();
var MAX_TERRAIN_RECORDS = 8192;

function decodeMask(maskPath){
    var mtimeMs = fs.statSync(maskPath).mtimeMs;
    var cached = decodedMasks.get(maskPath);
    if(cached && cached.mtimeMs === mtimeMs) return cached.promise;
    var promise = Jimp.read(maskPath);
    decodedMasks.set(maskPath, { mtimeMs: mtimeMs, promise: promise });
    promise.catch(function() {
        var current = decodedMasks.get(maskPath);
        if(current && current.promise === promise) decodedMasks.delete(maskPath);
    });
    return promise;
}

function Field(slot){
    this.flag = "kt";
    this.slot = slot;
    this.bitmapUrl = "";
    this.bitmapData = undefined;
    this.explosionRecord = [];
    this.explosionKeys = Object.create(null);
    this.pendingBotStateRefresh = false;
    this.width = 2800;
    this.height = 1400;
}

Field.prototype = {
    loadMapMask: function(mapName) {
        var map = this.slot.WOPW.mapsObj[mapName];
        if(!map || !map.mask) throw new Error("Missing mask metadata for " + mapName);
        var imagesBase = process.env.IMAGES_DIR || path.join(__dirname, '..', 'web', 'images');
        var maskPath = path.resolve(imagesBase, map.mask);
        if(!maskPath.startsWith(path.resolve(imagesBase) + path.sep) || !fs.existsSync(maskPath)) throw new Error("Missing terrain mask: " + map.mask);
        // Every human renderer acknowledges map_loaded. The room's carved copy
        // is already current after the first one, so later acks are free.
        if(this.bitmapData && this.loadedMaskPath === maskPath) return Promise.resolve(this.bitmapData);
        if(this.loadingMask && this.loadingMaskPath === maskPath) return this.loadingMask;
        var self = this;
        this.loadingMaskPath = maskPath;
        this.loadingMask = decodeMask(maskPath).then(function(source) {
            // Each room carves its own craters, so it needs a private copy.
            // Cloning is a memcpy; decoding the PNG/GIF in pure JS is the
            // expensive part and happens once per mask per process.
            var image = source.clone();
            self.bitmapData = image;
            self.loadedMaskPath = maskPath;
            self.width = image.width;
            self.height = image.height;
            if(DEBUG) console.log("Loaded terrain mask: " + map.mask);
            if(self.explosionRecord.length > 0){
                for(var k = 0; k < self.explosionRecord.length; k++){
                    var rec = self.explosionRecord[k];
                    var ex = Utils.stringToInt(rec[0]);
                    var ey = Utils.stringToInt(rec[1]);
                    var er = Utils.stringToInt(rec[2]);
                    if(Number.isFinite(ex) && Number.isFinite(ey) && Number.isFinite(er)){
                        self.clearExplosionPixels(ex, ey, er);
                    }
                }
            }
            return image;
        }).catch(function(err) {
            console.error("mask_error", err.message);
            throw err;
        }).finally(function() {
            if(self.loadingMaskPath === maskPath){
                self.loadingMask = null;
                self.loadingMaskPath = null;
            }
        });
        return this.loadingMask;
    },

    checkFieldCollisionPoint: function(x, y){
        try {
            // Outside the mask is open air/water. Jimp clamps out-of-range
            // coordinates to the edge pixel, which created phantom ground.
            if(x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
            // Jimp stores RGBA as 0xRRGGBBAA. The previous red-channel test
            // treated dark opaque terrain as empty and some transparent pixels
            // as solid.
            return Boolean(this.getFieldPointColor(x, y) & 0x000000ff);
        } catch(e) {
            return false;
        }
    },

    getFieldPointColor: function(x, y){
        try {
            return this.bitmapData.getPixelColor(x, y);
        } catch(e) {
            return 0;
        }
    },

    checkCollisionPointSet: function(x, y, pointSet, avg){
        if(this.bitmapData){
            for(var i = 0; i < pointSet.length; i++){
                var p = pointSet[i];
                if(p.X + x < 0 || p.Y + y < 0 || p.X + x >= this.width || p.Y + y >= this.height) continue;
                var pix = this.getFieldPointColor(p.X + x, p.Y + y);
                if(pix & 0x000000ff){
                    avg.sumX += p.X;
                    avg.sumY += p.Y;
                    avg.nP++;
                    avg.nGround++;
                }
            }
        }
        return avg;
    },

    explode: function(x, y, r){
        var record = [Utils.intToString(x), Utils.intToString(y), Utils.intToString(r)];
        // Server-side digs must bump the room's terrain revision exactly like
        // renderer-reported craters, or clients never converge on them.
        if(this.slot && typeof this.slot.applyTerrainMutation === "function") return this.slot.applyTerrainMutation([record]);
        return this.mergeExplosionRecords([record]);
    },

    // Spatial index of accepted craters (64 px cells) used to drop a report
    // that another renderer already sent with slightly different floats, or
    // that lies entirely inside an existing crater (Drill emits hundreds).
    craterCellKey: function(cx, cy){
        return cx + ":" + cy;
    },

    isCraterCovered: function(x, y, r){
        if(!this.craterCells) return false;
        var cell = 64;
        var reach = r + 64;
        var minX = Math.floor((x - reach) / cell), maxX = Math.floor((x + reach) / cell);
        var minY = Math.floor((y - reach) / cell), maxY = Math.floor((y + reach) / cell);
        for(var cx = minX; cx <= maxX; cx++){
            for(var cy = minY; cy <= maxY; cy++){
                var bucket = this.craterCells[this.craterCellKey(cx, cy)];
                if(!bucket) continue;
                for(var i = 0; i < bucket.length; i++){
                    var c = bucket[i];
                    var dx = c[0] - x, dy = c[1] - y;
                    // Covered when the new circle lies inside an existing one
                    // (0.75 px tolerance for float noise between renderers).
                    if(Math.sqrt(dx * dx + dy * dy) + r <= c[2] + 0.75) return true;
                }
            }
        }
        return false;
    },

    indexCrater: function(x, y, r){
        if(!this.craterCells) this.craterCells = Object.create(null);
        var key = this.craterCellKey(Math.floor(x / 64), Math.floor(y / 64));
        (this.craterCells[key] || (this.craterCells[key] = [])).push([x, y, r]);
    },

    mergeExplosionRecords: function(records){
        this.lastAcceptedRecords = [];
        if(!Array.isArray(records)) return 0;
        var accepted = 0;
        // A three-minute match cannot legitimately need an unbounded terrain
        // history. This limit also keeps malformed synchronization packets from
        // growing the room forever. Near-duplicate and covered craters are no
        // longer stored, so the cap is reached only by genuinely new damage.
        var limit = Math.min(records.length, MAX_TERRAIN_RECORDS);
        for(var i = 0; i < limit; i++){
            var record = records[i];
            if(!Array.isArray(record) || record.length < 3) continue;
            if(!record.slice(0, 3).every(function(value){
                return typeof value === "string" && /^[0-9A-F]{16}$/.test(value);
            })) continue;

            var x = Utils.stringToInt(record[0]);
            var y = Utils.stringToInt(record[1]);
            var r = Utils.stringToInt(record[2]);
            if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) continue;
            if(r <= 1 || r > 600) continue;
            if(x < -r || x > this.width + r || y < -r || y > this.height + r) continue;

            var canonical = [Utils.intToString(x), Utils.intToString(y), Utils.intToString(r)];
            var key = Math.round(x * 2) + ":" + Math.round(y * 2) + ":" + Math.round(r * 2);
            if(this.explosionKeys[key]) continue;
            this.explosionKeys[key] = true;
            if(this.isCraterCovered(x, y, r)) continue;
            if(this.explosionRecord.length >= MAX_TERRAIN_RECORDS){
                // Out of history: still carve the server mask so bots and
                // respawns see the hole, but stop growing the snapshot.
                this.clearExplosionPixels(x, y, r);
                continue;
            }
            this.explosionRecord.push(canonical);
            this.indexCrater(x, y, r);
            this.clearExplosionPixels(x, y, r);
            this.lastAcceptedRecords.push({ x: x, y: y, r: r, type: typeof record[3] === "string" ? record[3] : null });
            accepted++;
        }
        return accepted;
    },

    clearExplosionPixels: function(x, y, r){
        if(!this.bitmapData) return;
        var r2 = r * r;
        var startX = Math.max(0, Math.floor(x - r));
        var endX = Math.min(this.width - 1, Math.ceil(x + r));
        var startY = Math.max(0, Math.floor(y - r));
        var endY = Math.min(this.height - 1, Math.ceil(y + r));
        // Jimp#setPixelColor for every pixel creates hundreds of thousands of
        // function calls for Drill. Clear complete RGBA scanline spans in the
        // backing buffer instead. This produces the identical circular mask.
        var data = this.bitmapData.bitmap && this.bitmapData.bitmap.data;
        if(!data){
            // Small unit-test/custom adapters may expose only the public Jimp
            // pixel methods. Preserve compatibility outside the live Jimp
            // implementation.
            for(var fallbackY = startY; fallbackY <= endY; fallbackY++){
                for(var fallbackX = startX; fallbackX <= endX; fallbackX++){
                    var fallbackDx = fallbackX - x;
                    var fallbackDy = fallbackY - y;
                    if((fallbackDx * fallbackDx) + (fallbackDy * fallbackDy) <= r2){
                        this.bitmapData.setPixelColor(0, fallbackX, fallbackY);
                    }
                }
            }
            return;
        }
        for(var py = startY; py <= endY; py++){
            var dy = py - y;
            var halfWidth = Math.sqrt(Math.max(0, r2 - (dy * dy)));
            var rowStart = Math.max(startX, Math.floor(x - halfWidth));
            var rowEnd = Math.min(endX, Math.ceil(x + halfWidth));
            if(rowEnd < rowStart) continue;
            var byteStart = ((py * this.width) + rowStart) * 4;
            var byteEnd = ((py * this.width) + rowEnd + 1) * 4;
            data.fill(0, byteStart, byteEnd);
        }
    }
};

module.exports = Field;
