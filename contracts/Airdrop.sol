pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AirDrop is Ownable {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    function batchTransfer(address[] memory _recipients, uint256[] memory _values, address _tokenAddress) onlyOwner public returns (bool) {
        require(_recipients.length > 0 && _recipients.length == _values.length);

        uint256 totalTokenAmount = 0;
        for(uint j = 0; j < _recipients.length; j++) {
            totalTokenAmount = totalTokenAmount.add(_values[j]);
        }
        
        IERC20(_tokenAddress).safeTransferFrom(msg.sender, address(this), totalTokenAmount);

        for(uint j = 0; j < _recipients.length; j++){
            IERC20(_tokenAddress).safeTransfer(_recipients[j], _values[j]);
        }
 
        return true;
    }

    function withdraw(address tokenAddress) onlyOwner public { 
        IERC20(tokenAddress).safeTransfer(msg.sender, IERC20(tokenAddress).balanceOf(address(this)));
    }
}
