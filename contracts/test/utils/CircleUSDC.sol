// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice The slice of Circle's FiatToken v2.2 (native USDC) the tests use.
interface IFiatToken {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function version() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function nonces(address owner) external view returns (uint256);
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    // solhint-disable-next-line func-name-mixedcase
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    // solhint-disable-next-line func-name-mixedcase
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
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
    ) external;
    // admin surface
    function initialize(
        string calldata tokenName,
        string calldata tokenSymbol,
        string calldata tokenCurrency,
        uint8 tokenDecimals,
        address newMasterMinter,
        address newPauser,
        address newBlacklister,
        address newOwner
    ) external;
    function initializeV2(string calldata newName) external;
    function initializeV2_1(address lostAndFound) external;
    function initializeV2_2(address[] calldata accountsToBlacklist, string calldata newSymbol) external;
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}

/// @title Real Circle USDC for unit tests, set up like Arc's
/// @notice Arc's USDC ERC-20 interface (0x3600…0000) is a FiatTokenProxy over a FiatToken v2.2-compatible
///         implementation (EIP-712 domain "USDC" / "2", EIP-3009, EIP-2612, blocklist). Arc's own implementation
///         talks to the native-coin precompile, which a local EVM doesn't have, so the tests run Circle's audited
///         FiatToken v2.2 bytecode at Arc's address with Arc's name. Provenance: the runtime code of Arbitrum One native USDC — the FiatTokenProxy at
///         0xaf88d065e77c8cC2239327C5EDb3A432268e5831 and its FiatTokenV2_2 implementation at
///         0x86E721b43d4ECFa71119Dd38c0f938A75Fdb57B3 (from the proxy's implementation slot) plus the
///         SignatureChecker library it is linked against (0x4e7D093EE4d74a01905Cf5CA92eB0bf154a53247), fetched with
///         `cast code` from https://arb1.arbitrum.io/rpc at block 510,584,332 into `test/utils/bytecode/` —
///         at their canonical addresses and initializes it through Circle's own `initialize*` functions, so the
///         unit tests exercise the exact EIP-3009 / EIP-2612 / blacklist / pause code that runs on mainnet.
library CircleUSDC {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Arc's USDC address (mainnet and testnet)
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant IMPLEMENTATION = 0x86E721b43d4ECFa71119Dd38c0f938A75Fdb57B3;
    address internal constant SIGNATURE_CHECKER_LIB = 0x4e7D093EE4d74a01905Cf5CA92eB0bf154a53247;
    /// zeppelinos AdminUpgradeabilityProxy slots used by FiatTokenProxy
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;
    bytes32 internal constant ADMIN_SLOT = 0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b;

    // Test-only role holders (the proxy admin may not call token functions through the proxy).
    address internal constant PROXY_ADMIN = address(uint160(uint256(keccak256("mempire.test.usdc.proxyAdmin"))));
    address internal constant MASTER_MINTER = address(uint160(uint256(keccak256("mempire.test.usdc.masterMinter"))));
    address internal constant MINTER = address(uint160(uint256(keccak256("mempire.test.usdc.minter"))));
    address internal constant PAUSER = address(uint160(uint256(keccak256("mempire.test.usdc.pauser"))));
    address internal constant BLACKLISTER = address(uint160(uint256(keccak256("mempire.test.usdc.blacklister"))));
    address internal constant OWNER = address(uint160(uint256(keccak256("mempire.test.usdc.owner"))));
    address internal constant LOST_AND_FOUND = address(uint160(uint256(keccak256("mempire.test.usdc.lostAndFound"))));

    function deploy() internal returns (IFiatToken usdc) {
        usdc = IFiatToken(USDC);
        if (USDC.code.length != 0) return usdc; // already etched in this test
        vm.etch(USDC, _code("FiatTokenProxy"));
        vm.etch(IMPLEMENTATION, _code("FiatTokenV2_2"));
        vm.etch(SIGNATURE_CHECKER_LIB, _code("FiatSignatureChecker"));
        vm.store(USDC, IMPLEMENTATION_SLOT, bytes32(uint256(uint160(IMPLEMENTATION))));
        vm.store(USDC, ADMIN_SLOT, bytes32(uint256(uint160(PROXY_ADMIN))));
        vm.label(USDC, "USDC");

        // Arc's USDC: name() "USDC", version() "2"
        usdc.initialize("USDC", "USDC", "USD", 6, MASTER_MINTER, PAUSER, BLACKLISTER, OWNER);
        usdc.initializeV2("USDC");
        usdc.initializeV2_1(LOST_AND_FOUND);
        usdc.initializeV2_2(new address[](0), "USDC");
        vm.prank(MASTER_MINTER);
        usdc.configureMinter(MINTER, type(uint256).max);
    }

    function mint(address to, uint256 amount) internal {
        vm.prank(MINTER);
        IFiatToken(USDC).mint(to, amount);
    }

    function blacklist(address account) internal {
        vm.prank(BLACKLISTER);
        IFiatToken(USDC).blacklist(account);
    }

    function unBlacklist(address account) internal {
        vm.prank(BLACKLISTER);
        IFiatToken(USDC).unBlacklist(account);
    }

    function pause() internal {
        vm.prank(PAUSER);
        IFiatToken(USDC).pause();
    }

    function unpause() internal {
        vm.prank(PAUSER);
        IFiatToken(USDC).unpause();
    }

    function _code(string memory name) private view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(string.concat(vm.projectRoot(), "/test/utils/bytecode/", name, ".hex")));
    }
}
