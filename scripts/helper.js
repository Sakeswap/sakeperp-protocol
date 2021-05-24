"use strict";
exports.__esModule = true;
exports.sleep = exports.asyncExec = exports.getNpmBin = void 0;
var path_1 = require("path");
var shelljs_1 = require("shelljs");
function getNpmBin(cwd) {
    var options = { silent: true };
    if (cwd) {
        options.cwd = cwd;
    }
    return shelljs_1.exec("npm bin", options)
        .toString()
        .trim();
}
exports.getNpmBin = getNpmBin;
/**
 * Execute command in in local node_modules directory
 * @param commandAndArgs command with arguments
 */
function asyncExec(commandAndArgs, options) {
    var _a = commandAndArgs.split(" "), command = _a[0], args = _a.slice(1);
    var cwd = options ? options.cwd : undefined;
    var npmBin = path_1.resolve(getNpmBin(cwd), command);
    var realCommand = shelljs_1.test("-e", npmBin) ? npmBin + " " + args.join(" ") : commandAndArgs;
    console.log("> " + realCommand);
    return new Promise(function (resolve, reject) {
        var cb = function (code, stdout, stderr) {
            if (code !== 0) {
                reject(stderr);
            }
            else {
                resolve(stdout);
            }
        };
        if (options) {
            shelljs_1.exec(realCommand, options, cb);
        }
        else {
            shelljs_1.exec(realCommand, cb);
        }
    });
}
exports.asyncExec = asyncExec;
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
exports.sleep = sleep;
