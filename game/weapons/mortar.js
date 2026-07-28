var Physical = require("../physics/physical.js");
var Util = require("util");

function Mortar(properties, x, y, vx, vy, slot) {
    Physical.call(this);
    this.properties = properties;
    this.X = x;
    this.Y = y;
    this.Vx = vx;
    this.Vy = vy;
    this.slot = slot;
}

Util.inherits(Mortar, Physical);

Mortar.prototype.step = function() {
    var averageHit = this.slot.getCollisionAverage(this, this.boundPoints, false, true, true, true);

    this.Vx += (-this.Vx) * this.dt * this.windR;
    this.Vy = this.Vy + (this.gravity + (0 - this.Vy) * this.windR) * this.dt;

    if(averageHit.nP != 0){
        this.move();
        this.onComplete();
        return;
    }
}

Mortar.prototype.move = function() {
    var dY = this.Vy * this.dt;
    var dX = this.Vx * this.dt;
    this.X += dX;
    this.Y += dY;

    if(this.X < -10000 || this.Y < -10000) this.onComplete();

    if (this.Y > 1700) {
        this.onComplete();
    }
}

Mortar.prototype.onComplete = function() {
    this.complete = true;
    if (this.slot && this.slot.field) {
        this.slot.field.explode(this.X, this.Y, this.properties.Rdirt);
    }
}

module.exports = Mortar;
