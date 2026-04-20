// AegisNamespaceShims.cs
//
// Level Viewer batch-mode build shim.
//
// Project Aegis has references to assets/packages that are NOT committed
// to the repo:
//   * Odin Inspector (handled separately by OdinInspectorStubs.cs)
//   * AWS SDK (S3, SQS, GameLift, CloudWatchLogs, Runtime)
//   * FishNet "Pro" editor-only features (FishNet.Editing, FishNet.Configuring)
//   * Various custom types (BidirectionalNetworkTraffic, etc.)
//
// When we run Unity in batchmode the whole project must still compile, so
// we declare empty versions of every namespace that surviving source files
// reference only through `using` statements. Files that use these
// namespaces through real type-level references are removed by the batch
// runner instead — we only keep this file for "import-only" usages.
//
// This file is injected by the batch runner into every assembly that needs
// the shims: Assembly-CSharp (via Assets/LevelViewerShims/) and
// FishNet.Runtime (via Assets/StorePlugins/FishNet/Runtime/LevelViewerShims/).
//
// The empty-namespace trick: C# allows `using SomeNamespace;` even if the
// namespace contains zero types, as long as the namespace declaration
// exists somewhere in the compilation unit. So we declare all of them here
// as empty blocks. If the real asset ever gets installed, these empty
// namespaces coexist harmlessly with the real ones (namespaces merge).

#pragma warning disable CS0105 // duplicate using directives in downstream files
#pragma warning disable CS0108 // hiding inherited members (N/A here, defensive)

// === Amazon AWS SDK placeholders ===
namespace Amazon { }
namespace Amazon.Runtime { }
namespace Amazon.Runtime.Internal { }
namespace Amazon.Runtime.Internal.Transform { }
namespace Amazon.S3 { }
namespace Amazon.S3.Model { }
namespace Amazon.SQS { }
namespace Amazon.SQS.Model { }
namespace Amazon.GameLift { }
namespace Amazon.GameLift.Model { }
namespace Amazon.CloudWatchLogs { }
namespace Amazon.CloudWatchLogs.Model { }

// === FishNet "Pro" / editor-only namespaces ===
namespace FishNet.Editing { }
namespace FishNet.Editing.PrefabCollectionGenerator { }
namespace FishNet.Configuring { }
namespace FishNet.Configuring.EditorCloning { }

#pragma warning restore CS0108
#pragma warning restore CS0105
