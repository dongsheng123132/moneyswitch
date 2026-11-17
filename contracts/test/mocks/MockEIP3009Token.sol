// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockEIP3009Token
/// @notice Minimal ERC-20 + EIP-3009 `TransferWithAuthorization` (v/r/s flavour) test double.
///
/// @dev This is a *test* token, not production code. It mirrors the behaviour that matters for
///      QDayPayReceiver's tests:
///        - real EIP-712 domain separator (name / version / chainId / verifyingContract),
///        - real `ecrecover` signature verification against `from`,
///        - the `validAfter` / `validBefore` window,
///        - single-use nonces (`authorizationState`).
///      The EIP-712 domain is parameterised so tests exercise the exact tUSD8 domain
///      (name="tUSD8", version="2") as measured on QDay Aevum testnet.
contract MockEIP3009Token {
    // ---------------------------------------------------------------------
    // ERC-20 metadata / state
    // ---------------------------------------------------------------------

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---------------------------------------------------------------------
    // EIP-3009 state
    // ---------------------------------------------------------------------

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice Cached EIP-712 domain separator, built from {name} + {version}.
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => mapping(bytes32 => bool)) private _authorizationState;

    // ---------------------------------------------------------------------
    // Events / errors
    // ---------------------------------------------------------------------

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error InvalidSignature();
    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error InvalidAddress();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param name_    EIP-712 domain name (tUSD8 uses "tUSD8").
    /// @param version_ EIP-712 domain version (tUSD8 uses "2").
    /// @param decimals_ Token decimals (tUSD8 uses 6).
    constructor(string memory name_, string memory version_, uint8 decimals_) {
        name = name_;
        symbol = name_;
        decimals = decimals_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name_)),
                keccak256(bytes(version_)),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // Test helpers
    // ---------------------------------------------------------------------

    /// @notice Unrestricted mint - test only.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert InvalidAddress();
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Compute the EIP-712 digest a payer must sign for {transferWithAuthorization}.
    /// @dev Exposed so tests can sign with `vm.sign` without duplicating the encoding.
    function transferWithAuthorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // ---------------------------------------------------------------------
    // ERC-20
    // ---------------------------------------------------------------------

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(msg.sender, allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    // ---------------------------------------------------------------------
    // EIP-3009
    // ---------------------------------------------------------------------

    /// @notice Execute a transfer authorised off-chain by `from` (EIP-3009, v/r/s flavour).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp < validAfter) revert AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        if (_authorizationState[from][nonce]) revert AuthorizationAlreadyUsed(from, nonce);

        bytes32 digest = transferWithAuthorizationDigest(from, to, value, validAfter, validBefore, nonce);
        // `ecrecover` returns address(0) for a malformed signature, which never equals `from`
        // here because `from` is validated non-zero by the caller contract.
        if (ecrecover(digest, v, r, s) != from) revert InvalidSignature();

        _authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice True once the nonce has been consumed for `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationState[authorizer][nonce];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance(from, balance, value);
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
