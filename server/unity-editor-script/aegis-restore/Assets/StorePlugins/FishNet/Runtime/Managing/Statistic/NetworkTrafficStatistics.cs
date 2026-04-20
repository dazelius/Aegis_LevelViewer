// NetworkTrafficStatistics.cs — LEVEL VIEWER STUB
//
// Minimal stand-in for FishNet's NetworkTrafficStatistics. The original
// file references `FishNet.Editing.*`, `BidirectionalNetworkTraffic`, and
// other types from the "Pro" edition of FishNet that aren't committed to
// this repo. FishNet's core runtime *also* references this type (see
// StatisticsManager, TransportManager, NetworkBehaviour, etc.), so we
// can't simply delete it — we have to provide a compile-compatible shell.
//
// The level-viewer batch export never runs networking, so all methods
// here are no-ops. The public surface is the subset that FishNet.Runtime
// actually calls.

using FishNet.Transporting;
using UnityEngine;

namespace FishNet.Managing.Statistic
{
    public enum EnabledMode
    {
        Disabled = 0,
        Enabled = 1,
    }

    public class NetworkTrafficStatistics
    {
        public EnabledMode EnableMode => EnabledMode.Disabled;
        public bool UpdateClient => false;
        public bool UpdateServer => false;

        public void SetUpdateClient(bool update) { }
        public void SetUpdateServer(bool update) { }

        public bool IsEnabled() => false;

        public void AddOutboundPacketIdData(PacketId packetId, string details, long length, GameObject gameObject, bool asServer) { }
        public void AddInboundPacketIdData(PacketId packetId, string details, long length, GameObject gameObject, bool asServer) { }
        public void AddOutboundSocketData(long bytes, bool asServer) { }
        public void AddInboundSocketData(long bytes, bool asServer) { }

        public void InitializeOnce_Internal(NetworkManager manager) { }

        public static string FormatBytesToLargest(double bytes) => $"{bytes} B";
    }
}
