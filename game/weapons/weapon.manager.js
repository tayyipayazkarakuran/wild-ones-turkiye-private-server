var Mortar = require('./mortar.js');

function Weapon(slot) {
    this.slot = slot;
}

Weapon.prototype = {
    makeWeapon: function(properties, x, y, vx, vy){
       switch(properties.type){
            case "mortar":
            case "nuke":
            case "meganuke":
            case "gonuke":
            case "babynuke":
                return new Mortar(properties, x, y, vx, vy, this.slot);
            default:
                return new Mortar(properties, x, y, vx, vy, this.slot);
       }
    }
};

module.exports = Weapon;
