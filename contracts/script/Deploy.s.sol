// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MempireToken} from "../src/MempireToken.sol";
import {MempireCards} from "../src/MempireCards.sol";
import {MempireArena} from "../src/MempireArena.sol";
import {MarketMeta} from "../src/MarketMeta.sol";
import {MirrorAggregator} from "../src/testnet/MirrorAggregator.sol";
import {MempireCCIPGateway} from "../src/ccip/MempireCCIPGateway.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";

/// Deploys the whole game to Arc and registers the roster from shared/roster.json.
/// One script for Arc testnet (5042002), Arc mainnet (5042) and a local Arc fork:
/// run it through `scripts/deploy.sh testnet|mainnet`, which sets the env below.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  broadcasts; owns the contracts until ADMIN accepts them
///   RELAYER               the relay's address: mints starter decks (never the owner)
///   (prices)              each fighter reads its Chainlink Data Feed proxy from shared/roster.json
///                         (Arc mainnet addresses). Where that proxy has no code — Arc testnet,
///                         which Chainlink does not serve — a MirrorAggregator of it is deployed,
///                         updated by RELAYER from the mainnet feed (testnet only; refused on 5042).
///   CCIP_ROUTER           Chainlink CCIP router on this chain (enables the cross-chain entry gateway;
///                         Arc mainnet 0xB797…3A18, testnet 0xdE4E…eab8). Unset = no gateway.
///   TOKEN_MESSENGER       Circle CCTP V2 TokenMessenger (mainnet 0x28b5…cf5d, testnet 0x8FE6…2DAA)
///   MAX_CASH_OUT          per-message CCTP cash-out cap through the gateway, USDC 6 decimals (default 100e6)
///   CRE_FORWARDER         KeystoneForwarder for MarketMeta.onReport (Arc testnet only; 0 = none)
///   TREASURY              receives rake and mint fees (default: deployer)
///   ADMIN                 if set and not the deployer: ownership is offered to it (Ownable2Step)
///   MAX_TIER              highest stake tier open: 0 = $1 … 3 = $100 (default 3; mainnet 1)
///   MINT_FEE              USDC per mint, 6 decimals (default 50000 = $0.05; max $5)
///   METADATA_BASE_URI     where tokenURI points
///   TIME_SCALE            divides chest timers (60 on testnet, 1 on mainnet)
///   ADDRESSES_OUT         where to write the addresses (default shared/deployments/<chainId>.json)
contract Deploy is Script {
    using stdJson for string;

    /// Arc's USDC ERC-20 interface (6 decimals), the same address on testnet and mainnet.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant REWARD_POOL = 1_000_000 ether;

    struct Env {
        uint256 pk;
        address deployer;
        address relayer;
        address ccipRouter;
        address tokenMessenger;
        uint256 maxCashOut;
        address forwarder;
        address treasury;
        address admin;
        uint8 maxTier;
        uint256 mintFee;
        string baseUri;
        uint32 timeScale;
        string out;
    }

    struct Deployed {
        MempireToken token;
        MempireCards cards;
        MarketMeta meta;
        MempireArena arena;
        MempireCCIPGateway gateway;
        uint256 mirrors;
    }

    function run() external virtual {
        _run(_env());
    }

    function _run(Env memory e) internal {
        require(USDC.code.length > 0, "no USDC at 0x3600...0000: not an Arc chain (or fork)");
        require(e.relayer != e.deployer, "RELAYER must not be the deployer/owner");
        (bytes32[] memory feedIds, string[] memory tickers, uint32[] memory ages, address[] memory feeds,
            uint8[] memory decimals) = _roster();

        vm.startBroadcast(e.pk);
        Deployed memory d = _deploy(e);
        // Chainlink's proxy where it exists on this chain; a testnet mirror of it where it does not.
        for (uint256 i; i < feeds.length; ++i) {
            if (feeds[i].code.length == 0) {
                require(block.chainid != 5042, "a roster feed has no code on Arc mainnet");
                feeds[i] = address(
                    new MirrorAggregator(
                        e.relayer, feeds[i], decimals[i], string.concat(tickers[i], " / USD (mirror of Arc mainnet)")
                    )
                );
                d.mirrors++;
            }
        }
        d.cards.registerCoins(feedIds, tickers, ages, feeds);
        d.token.transfer(address(d.arena), REWARD_POOL);
        if (e.admin != address(0) && e.admin != e.deployer) {
            d.cards.transferOwnership(e.admin);
            d.meta.transferOwnership(e.admin);
            d.arena.transferOwnership(e.admin);
            if (address(d.gateway) != address(0)) d.gateway.transferOwnership(e.admin);
        }
        vm.stopBroadcast();

        console2.log("MempireToken      ", address(d.token));
        console2.log("MempireCards      ", address(d.cards));
        console2.log("MarketMeta        ", address(d.meta));
        console2.log("MempireArena      ", address(d.arena));
        console2.log("CCIP gateway      ", address(d.gateway));
        console2.log("feed mirrors      ", d.mirrors);
        _write(e, d);
    }

    function _env() internal view returns (Env memory e) {
        e.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        e.deployer = vm.addr(e.pk);
        e.relayer = vm.envAddress("RELAYER");
        e.ccipRouter = vm.envOr("CCIP_ROUTER", address(0));
        e.tokenMessenger = vm.envOr("TOKEN_MESSENGER", address(0));
        e.maxCashOut = vm.envOr("MAX_CASH_OUT", uint256(100e6));
        e.forwarder = vm.envOr("CRE_FORWARDER", address(0));
        e.treasury = vm.envOr("TREASURY", e.deployer);
        e.admin = vm.envOr("ADMIN", address(0));
        e.maxTier = uint8(vm.envOr("MAX_TIER", uint256(3)));
        e.mintFee = vm.envOr("MINT_FEE", uint256(50_000));
        e.baseUri = vm.envString("METADATA_BASE_URI");
        e.timeScale = uint32(vm.envOr("TIME_SCALE", uint256(60)));
        e.out = vm.envOr(
            "ADDRESSES_OUT",
            string.concat(vm.projectRoot(), "/../shared/deployments/", vm.toString(block.chainid), ".json")
        );
    }

    function _roster()
        internal
        view
        returns (
            bytes32[] memory feedIds,
            string[] memory tickers,
            uint32[] memory ages,
            address[] memory feeds,
            uint8[] memory decimals
        )
    {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../shared/roster.json"));
        uint256 n = abi.decode(vm.parseJson(json, ".coins[*].coinId"), (uint256[])).length;
        feedIds = new bytes32[](n);
        tickers = new string[](n);
        ages = new uint32[](n);
        feeds = new address[](n);
        decimals = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".coins[", vm.toString(i), "]");
            require(json.readUint(string.concat(k, ".coinId")) == i, "roster out of order");
            feedIds[i] = json.readBytes32(string.concat(k, ".feedId"));
            tickers[i] = json.readString(string.concat(k, ".ticker"));
            ages[i] = uint32(json.readUint(string.concat(k, ".maxPriceAge")));
            feeds[i] = json.readAddress(string.concat(k, ".feed"));
            decimals[i] = uint8(json.readUint(string.concat(k, ".decimals")));
        }
    }

    function _deploy(Env memory e) internal returns (Deployed memory d) {
        d.token = new MempireToken(e.deployer);
        d.cards = new MempireCards(e.deployer, d.token, IERC20(USDC), e.treasury, e.mintFee, e.timeScale, e.baseUri);
        d.meta = new MarketMeta(e.deployer, e.forwarder);
        d.arena = new MempireArena(e.deployer, d.cards, USDC, d.meta, e.treasury, e.maxTier);
        d.cards.setArena(address(d.arena));
        d.cards.setRelayer(e.relayer);
        d.meta.setCards(d.cards);
        if (e.ccipRouter != address(0)) {
            require(e.tokenMessenger != address(0), "CCIP_ROUTER needs TOKEN_MESSENGER (CCTP V2) for cash-outs");
            d.gateway = new MempireCCIPGateway(
                e.deployer, e.ccipRouter, d.arena, IERC20(USDC), ITokenMessengerV2(e.tokenMessenger), e.maxCashOut
            );
            d.arena.setEntryGateway(address(d.gateway));
            // Remote entries (Base / Ethereum) are allowlisted once deployed there:
            // scripts/deploy-remote.sh prints the setRemoteEntry call for the owner.
        }
    }

    function _write(Env memory e, Deployed memory d) internal {
        if (keccak256(bytes(e.out)) == keccak256("none")) return;
        string memory o = "deployment";
        o.serialize("chainId", block.chainid);
        o.serialize("deployer", e.deployer);
        o.serialize("relayer", e.relayer);
        o.serialize("usdc", USDC);
        o.serialize("priceFeeds", d.mirrors == 0 ? string("chainlink") : string("mirror"));
        o.serialize("ccipRouter", e.ccipRouter);
        o.serialize("tokenMessenger", e.tokenMessenger);
        o.serialize("ccipGateway", address(d.gateway));
        o.serialize("creForwarder", e.forwarder);
        o.serialize("treasury", e.treasury);
        o.serialize("admin", e.admin == address(0) ? e.deployer : e.admin);
        o.serialize("maxTier", uint256(e.maxTier));
        o.serialize("mintFee", e.mintFee);
        o.serialize("timeScale", uint256(e.timeScale));
        o.serialize("startBlock", block.number);
        o.serialize("token", address(d.token));
        o.serialize("cards", address(d.cards));
        o.serialize("marketMeta", address(d.meta));
        string memory out = o.serialize("arena", address(d.arena));
        vm.writeJson(out, e.out);
    }
}
