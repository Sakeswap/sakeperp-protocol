"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function () { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function () { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
exports.flatten = exports.FLATTEN_BASE_DIR = void 0;
var path_1 = require("path");
var shelljs_1 = require("shelljs");
var helper_1 = require("./helper");
exports.FLATTEN_BASE_DIR = "./flattened";
function flatten(fromDir, toDir, filename) {
    return __awaiter(this, void 0, void 0, function () {
        var licenseDeclared, versionDeclared, abiV2Declared, fromFile, toFile, flattened, trimmed;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    licenseDeclared = false;
                    versionDeclared = false;
                    abiV2Declared = false;
                    fromFile = path_1.join(fromDir, filename);
                    toFile = path_1.join(toDir, filename);
                    shelljs_1.mkdir("-p", toDir);
                    return [4 /*yield*/, helper_1.asyncExec("truffle-flattener " + fromFile)];
                case 1:
                    flattened = _a.sent();
                    console.log(flattened);
                    trimmed = flattened.split("\n").filter(function (line) {
                        if (line.indexOf("SPDX-License-Identifier") !== -1) {
                            if (!licenseDeclared) {
                                licenseDeclared = true;
                                return true;
                            }
                            else {
                                return false;
                            }
                        }
                        else if (line.indexOf("pragma solidity") !== -1) {
                            if (!versionDeclared) {
                                versionDeclared = true;
                                return true;
                            }
                            else {
                                return false;
                            }
                        }
                        else if (line.indexOf("pragma experimental ABIEncoderV2") !== -1) {
                            if (!abiV2Declared) {
                                abiV2Declared = true;
                                return true;
                            }
                            else {
                                return false;
                            }
                        }
                        else {
                            return true;
                        }
                    });
                    shelljs_1.ShellString(trimmed.join("\n")).to(toFile);
                    return [2 /*return*/];
            }
        });
    });
}
exports.flatten = flatten;
if (require.main === module) {
    flatten("./contracts", "./flattened/", "SakePerp.sol")
    flatten("./contracts", "./flattened/", "Exchange.sol")
    flatten("./contracts", "./flattened/", "ExchangeState.sol")
    flatten("./contracts", "./flattened/", "ExchangeReader.sol")
    flatten("./contracts", "./flattened/", "BSCPriceFeed.sol")
    flatten("./contracts", "./flattened/", "L2PriceFeed.sol")
    flatten("./contracts", "./flattened/", "SakePerpVault.sol")
    flatten("./contracts", "./flattened/", "SystemSettings.sol")
    flatten("./contracts", "./flattened/", "InsuranceFund.sol")
    flatten("./contracts", "./flattened/", "SakePerpState.sol")
    flatten("./contracts", "./flattened/", "SakePerpViewer.sol")
    flatten("./contracts", "./flattened/", "MMLPToken.sol")
    flatten("./contracts/test", "./flattened/", "ERC20.sol")
}
