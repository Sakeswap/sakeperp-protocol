"use strict";

const fs = require("fs");
const { keccak256 } = require("@ethersproject/keccak256");
const sakeSwapPair = require("../build/contracts/SakeSwapPair.json");

const f = "contracts/sakeswap/libraries/SakeSwapLibrary.sol";

// console.log(sakeSwapPair.bytecode);

// update SakeSwapLibrary init code hash
fs.readFile(f, "utf-8", (err, data) => {
  if (err) {
    return console.log(err);
  }

  let m = data.match(/hex'(\S{64})'/);
  if (m !== null && m.length > 0) {
    let originHash = m[1];
    console.log(`find init code hash: ${originHash}`);
    let generateHash = keccak256(sakeSwapPair.bytecode).slice(2);
    console.log(`generate init code hash: ${generateHash}`);

    if (generateHash !== originHash) {
      let result = data.replace(/hex'\S{64}'/g, `hex'${generateHash}'`);

      fs.writeFile(f, result, "utf8", function (err) {
        if (err) {
          return console.error(err);
        }
      });
    } else {
      console.log("The hash value has not changed and does not need to be replaced.");
    }
  } else {
    console.error("no replacement hash value could be found");
  }
});
