const Tx = require('ethereumjs-tx').Transaction;
const fs = require('fs')
const Web3 = require('web3')
const BigNumber = require("bignumber.js");
const { MAX_UINT256 } = require('@openzeppelin/test-helpers/src/constants');
const { BN } = require('@openzeppelin/test-helpers');

const fromHexString = hexString => new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

const privatekey = fromHexString("")
const senderAccount = ""
let web3 = new Web3(new Web3.providers.HttpProvider('https://data-seed-prebsc-1-s1.binance.org:8545'));
let airDropContractAddress = "0x5d3100ba03c3b7654e499d7ddfc4ce4fb75fbd96";
let busdAddress = "0x4a6c176c493ceaac524acd578317a68358977511"
let chainId = 97 //bsc test net

let gasLimit = 5000000;
let gasPrice = 10000000000;
let batchStep = 180;


function toFullDigit(val, decimals = 18) {
  const tokenDigit = new BigNumber("10").exponentiatedBy(decimals)
  const bigNumber = new BigNumber(val).multipliedBy(tokenDigit).toFixed(0)
  return new BN(bigNumber)
}

let AirDropAccount = {}

async function ApproveAirDrop() {
  try {
    let currentNonce = (await web3.eth.getTransactionCount(senderAccount))

    let data = web3.eth.abi.encodeFunctionCall({
      name: 'approve',
      type: 'function',
      inputs: [
        {
          name: "spender",
          type: "address"
        },
        {
          name: "value",
          type: "uint256"
        }
      ],
    }, [
      airDropContractAddress,
      MAX_UINT256
    ]);

    const Common = require('ethereumjs-common').default
    const customCommon = Common.forCustomChain(
      'mainnet',
      {
        name: 'my-network',
        networkId: 5,
        chainId: chainId,
      },
      'petersburg',
    )

    const txData = {
      gasLimit: gasLimit,
      gasPrice: gasPrice,
      to: busdAddress,
      value: '0x0',
      nonce: currentNonce,
      data: data,
      from: senderAccount,
      chainId: chainId
    }

    const transaction = new Tx(txData, { common: customCommon })
    transaction.sign(privatekey)
    const serializedTx = transaction.serialize().toString('hex')
    await web3.eth.sendSignedTransaction("0x" + serializedTx)
  }
  catch (error) {
    console.log(error);
  }
}

async function LoadAirDropTable() {
  try {
      let fileName = "./SakePerp.csv";
      let data = fs.readFileSync(fileName)

      data = data.toString();
      var rows = new Array();
      rows = data.split("\n");
      for (var i = 1; i < rows.length; i++) {
          let dataArray = rows[i].split(",");
          if(dataArray[1] != "")
          {
            AirDropAccount[dataArray[1]] = toFullDigit(dataArray[5])
          }
      }
      
  } catch (error) {
      console.log(error)
  }

  return true
}

async function BatchTransfer(addressArray, valueArray, tokenAddress) {
  try {
    let currentNonce = (await web3.eth.getTransactionCount(senderAccount))
    let data = web3.eth.abi.encodeFunctionCall({
      name: 'batchTransfer',
      type: 'function',
      inputs: [
        {
          name: "_recipients",
          type: "address[]"
        },
        {
          name: "_values",
          type: "uint256[]"
        },
        {
          name: "_tokenAddress",
          type: "address"
        }
      ],
    }, [
      addressArray,
      valueArray,
      busdAddress
    ]);

    const Common = require('ethereumjs-common').default
    const customCommon = Common.forCustomChain(
      'mainnet',
      {
        name: 'my-network',
        networkId: 5,
        chainId: chainId,
      },
      'petersburg',
    )

    const txData = {
      gasLimit: gasLimit,
      gasPrice: gasPrice,
      to: airDropContractAddress,
      value: '0x0',
      nonce: currentNonce,
      data: data,
      from: senderAccount,
      chainId: chainId
    }

    const transaction = new Tx(txData, { common: customCommon })
    transaction.sign(privatekey)
    const serializedTx = transaction.serialize().toString('hex')
    let tx = await web3.eth.sendSignedTransaction("0x" + serializedTx)
    console.log("batch transfer txHash = ", tx["transactionHash"])
  }
  catch (error) {
    console.log(error);
  }
}

async function AirDrop() {
  try {
    await LoadAirDropTable()


    let addressArray = new Array()
    let valueArray = new Array()
    for(var key in AirDropAccount) {
      addressArray.push(key)
      valueArray.push(AirDropAccount[key].toString())
      if(addressArray.length >= batchStep) {
        await BatchTransfer(addressArray, valueArray)
        addressArray = new Array()
        valueArray = new Array()
      }
    }
    await BatchTransfer(addressArray, valueArray)
  } catch (error) {
    console.log(error)
  }
}

async function main() {
  try {
    //await ApproveAirDrop()
    await AirDrop()
  } catch (error) {
    console.log(error)
  }
}

main()