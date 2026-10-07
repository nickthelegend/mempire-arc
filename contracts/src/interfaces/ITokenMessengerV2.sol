// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Circle CCTP V2 TokenMessenger — the slice Mempire calls.
/// Same address on every CCTP V2 chain: 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d (mainnets),
/// 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA (testnets). Domains: Ethereum 0, Base 6, Arc 26.
interface ITokenMessengerV2 {
    /// Burns `amount` of `burnToken` here; Circle's attestation lets anyone (or
    /// `destinationCaller`, if set) mint it to `mintRecipient` on `destinationDomain`.
    /// `minFinalityThreshold` 1000 = Fast Transfer (fee up to `maxFee`), 2000 = Standard.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}
