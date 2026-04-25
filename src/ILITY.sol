// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.5.0
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts@5.5.0/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts@5.5.0/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts@5.5.0/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts@5.5.0/access/Ownable.sol";

contract ILITY is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    constructor(address recipient, address initialOwner)
        ERC20("ILITY", "ILY")
        ERC20Permit("ILITY")
        Ownable(initialOwner)
    {
        _mint(recipient, 1_000_000_000 * 10 ** decimals());
    }
}
