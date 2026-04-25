// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts@5.5.0/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts@5.5.0/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts@5.5.0/access/Ownable.sol";

/// @title Lockup
/// @notice ERC20 token lockup with per-address schedules and UUPS upgradeability
/// @dev Owner (usually a trusted admin) can create lockups; users claim after unlock time
/// @custom:security-contact N/A
contract Lockup is Ownable {
    /// @dev SafeERC20 adds safe transfer helpers that handle non-standard ERC20s
    using SafeERC20 for IERC20;

    /// @notice Single lock entry for an account
    struct Lock {
        uint256 amount; // Amount of tokens locked
        uint64 unlockTime; // UNIX timestamp (seconds) when tokens become claimable
        bool claimed; // True once tokens are claimed
    }

    /// @notice ERC20 token being locked
    IERC20 public token;

    /// @dev Per-account list of lock entries
    mapping(address => Lock[]) public _locks;

    constructor(address token_, address initialOwner) Ownable(initialOwner) {
        require(token_ != address(0), "token=0");
        token = IERC20(token_);
    }

    /// @notice Emitted when a new lockup is created for an account
    event LockupAdded(address indexed account, uint256 indexed index, uint256 amount, uint256 unlockTime);
    /// @notice Emitted when a single lockup is claimed
    event Claimed(address indexed account, uint256 indexed index, uint256 amount);
    /// @notice Emitted when all claimable lockups are claimed in one call
    event ClaimedAll(address indexed account, uint256 amount);

    /// @notice Returns the number of lockups for an account
    /// @param account Account to query
    /// @return count Number of lockup entries
    function lockupCount(address account) external view returns (uint256) {
        return _locks[account].length;
    }

    /// @notice Returns a specific lockup entry for an account
    /// @param account Account address
    /// @param index Lockup index within the account array
    /// @return amount Amount locked
    /// @return unlockTime UNIX timestamp when tokens become claimable
    /// @return claimed Whether the lockup has been claimed
    function lockupOf(address account, uint256 index)
        external
        view
        returns (uint256 amount, uint256 unlockTime, bool claimed)
    {
        Lock memory lock_ = _locks[account][index];
        return (lock_.amount, lock_.unlockTime, lock_.claimed);
    }

    /// @notice Sum of all claimable (unlocked and unclaimed) amounts for an account
    /// @param account Account to query
    /// @return total Total claimable amount
    function claimableAmount(address account) public view returns (uint256 total) {
        Lock[] storage locks = _locks[account];
        uint256 length = locks.length;
        for (uint256 i = 0; i < length; i++) {
            if (!locks[i].claimed && locks[i].unlockTime <= block.timestamp) {
                total += locks[i].amount;
            }
        }
    }

    /// @notice Sum of all locked (still time-locked and unclaimed) amounts for an account
    /// @param account Account to query
    /// @return total Total locked amount
    function lockedAmount(address account) public view returns (uint256 total) {
        Lock[] storage locks = _locks[account];
        uint256 length = locks.length;
        for (uint256 i = 0; i < length; i++) {
            if (!locks[i].claimed && locks[i].unlockTime > block.timestamp) {
                total += locks[i].amount;
            }
        }
    }

    /// @notice Create a lockup for a single account
    /// @dev Transfers tokens from caller to this contract
    /// @param account Beneficiary address
    /// @param amount Amount of tokens to lock
    /// @param unlockTime UNIX timestamp when tokens become claimable
    function lock(address account, uint256 amount, uint256 unlockTime) external onlyOwner {
        require(account != address(0), "account=0");
        require(amount > 0, "amount=0");
        require(unlockTime > block.timestamp, "unlockTime<=now");
        require(unlockTime <= type(uint64).max, "unlockTime too large");

        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 index = _locks[account].length;
        // Casting is safe because unlockTime is checked against type(uint64).max above.
        // forge-lint: disable-next-line(unsafe-typecast)
        _locks[account].push(Lock({amount: amount, unlockTime: uint64(unlockTime), claimed: false}));
        emit LockupAdded(account, index, amount, unlockTime);
    }

    /// @notice Create lockups for multiple accounts in a single call
    /// @dev Transfers the total amount from caller to this contract once
    /// @param accounts List of beneficiary addresses
    /// @param amounts List of token amounts per beneficiary
    /// @param unlockTimes List of unlock timestamps per beneficiary
    function lockBatch(address[] calldata accounts, uint256[] calldata amounts, uint256[] calldata unlockTimes)
        external
        onlyOwner
    {
        uint256 length = accounts.length;
        require(length == amounts.length && length == unlockTimes.length, "length mismatch");
        require(length > 0, "empty");

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < length; i++) {
            require(accounts[i] != address(0), "account=0");
            require(amounts[i] > 0, "amount=0");
            require(unlockTimes[i] > block.timestamp, "unlockTime<=now");
            require(unlockTimes[i] <= type(uint64).max, "unlockTime too large");
            totalAmount += amounts[i];
        }

        token.safeTransferFrom(msg.sender, address(this), totalAmount);

        for (uint256 i = 0; i < length; i++) {
            uint256 index = _locks[accounts[i]].length;
            _locks[accounts[i]].push(
                // Casting is safe because each unlock time is checked against type(uint64).max above.
                // forge-lint: disable-next-line(unsafe-typecast)
                Lock({amount: amounts[i], unlockTime: uint64(unlockTimes[i]), claimed: false})
            );
            emit LockupAdded(accounts[i], index, amounts[i], unlockTimes[i]);
        }
    }

    /// @notice Claim a specific lockup by index
    /// @param index Lockup index within caller's array
    function claim(uint256 index) external {
        Lock storage lock_ = _locks[msg.sender][index];
        require(!lock_.claimed, "already claimed");
        require(lock_.unlockTime <= block.timestamp, "locked");

        lock_.claimed = true;
        token.safeTransfer(msg.sender, lock_.amount);
        emit Claimed(msg.sender, index, lock_.amount);
    }

    /// @notice Claim all unlocked, unclaimed lockups for caller
    /// @dev Loops through all lockups for the caller; gas grows with lockup count
    /// @return totalClaimed Sum of claimed amounts
    function claimAll() external returns (uint256 totalClaimed) {
        Lock[] storage locks = _locks[msg.sender];
        uint256 length = locks.length;
        for (uint256 i = 0; i < length; i++) {
            if (!locks[i].claimed && locks[i].unlockTime <= block.timestamp) {
                locks[i].claimed = true;
                totalClaimed += locks[i].amount;
            }
        }

        require(totalClaimed > 0, "nothing claimable");
        token.safeTransfer(msg.sender, totalClaimed);
        emit ClaimedAll(msg.sender, totalClaimed);
    }
}
