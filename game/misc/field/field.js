var Jimp = require('jimp'),
    Utils = require('../../helpers/utils.js');

function Field(){
    this.name = "";
    this.bitmapData = null;
    this.explosionRecord = [];
}

Field.prototype = {
    checkCollisionPointSet: function(x, y, pointSet, avg){
        if(this.bitmapData){
            var nPoints = pointSet.length;
            var i = 0;
            while(i < nPoints){
                var p = pointSet[i];
                var pix = this.bitmapData.getPixelColor(p.x + x, p.y + y);
                if(pix & 4278190080){
                    avg.sumX += p.x;
                    avg.sumY += p.y;
                    avg.nP++;
                    avg.nGround++;
                }
                i++;
            }
        }
        return avg;
    },

    explode: function(x, y, r){
        if(r <= 1) return;
        this.explosionRecord.push([Utils.intToString(x), Utils.intToString(y), Utils.intToString(r)]);
    },

    getCircle: function(rad){
        var dia = 2 * rad;
        var rr = rad * rad;
        var result = new Jimp(dia, dia, 0x00000000);

        for(var i = 0; i < dia; i++){
            var dx = (i - rad);
            var dx2 = (dx * dx);
            for(var j = 0; j < dia; j++){
                var dy = (j - rad);
                var dy2 = (dy * dy);
                if(dx2 + dy2 <= rr){
                    result.setPixelColor(0x00000000, i, j);
                } else {
                    result.setPixelColor(0xFFFFFFFF, i, j);
                }
            }
        }
        return result;
    }
};

module.exports = Field;
