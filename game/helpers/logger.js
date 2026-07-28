var fs = require('fs');

class Logger{
    constructor(filename){
        this.filename = filename + ".log";
    }

    write(text){
        var logText = new Date().toString() + " -- " + text + "\n";
        fs.appendFile('logs/' + this.filename, logText, (err) => {
        });
    }
}

module.exports = Logger;
