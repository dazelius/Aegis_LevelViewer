// SPDX-License-Identifier: MIT
// OdinInspectorStubs.cs
//
// Project Aegis' FishNet-integrated GameKit scripts reference attributes
// from Sirenix.OdinInspector (a paid Asset Store package) that aren't
// committed to the git repo. Each developer installs Odin locally. Our
// read-only batch-mode exporter only needs the compile step to succeed —
// we don't care whether the attributes actually affect the inspector — so
// we provide minimal no-op shims that match the class names FishNet uses.
//
// These stubs are INERT: they contain no behaviour, only satisfy the type
// checker so Assembly-CSharp can load and `LevelViewerExporter.ExportCli`
// becomes callable via -executeMethod.
//
// Rules of thumb:
//   - Declared in `Sirenix.OdinInspector` namespace so existing `using`
//     directives resolve unchanged.
//   - Constructors accept `params object[]` to silently match any overload
//     callers use (e.g. `[TabGroup("MyTab")]` or `[TabGroup("a", "b", true)]`).
//   - All attribute targets open (AttributeTargets.All) so we don't
//     inadvertently reject any placement FishNet uses.
//
// If Odin IS actually installed in the project, the real types would
// conflict with these. We ship them under a symbol guard so a true install
// can disable the shims by defining LEVELVIEWER_HAS_ODIN in Project
// Settings > Player > Scripting Define Symbols.

#if !LEVELVIEWER_HAS_ODIN
using System;

namespace Sirenix.OdinInspector
{
    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class TabGroupAttribute : Attribute
    {
        public TabGroupAttribute() { }
        public TabGroupAttribute(string group) { }
        public TabGroupAttribute(string group, string tab) { }
        public TabGroupAttribute(string group, string tab, bool useFixedHeight) { }
        public TabGroupAttribute(string group, string tab, bool useFixedHeight, float order) { }
        public TabGroupAttribute(string groupIdA, string groupIdB, string groupIdC) { }
        public TabGroupAttribute(string group, params string[] tabs) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class ShowIfAttribute : Attribute
    {
        public ShowIfAttribute() { }
        public ShowIfAttribute(string condition) { }
        public ShowIfAttribute(string condition, object value) { }
        public ShowIfAttribute(string condition, object value, bool animate) { }
    }

    // FishNet pulls in a handful of additional common Odin attributes;
    // defining them pre-emptively saves us from whack-a-mole future errors
    // when slightly different scenes pull in different referenced files.
    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class HideIfAttribute : Attribute
    {
        public HideIfAttribute(string condition) { }
        public HideIfAttribute(string condition, object value) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class EnableIfAttribute : Attribute
    {
        public EnableIfAttribute(string condition) { }
        public EnableIfAttribute(string condition, object value) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class DisableIfAttribute : Attribute
    {
        public DisableIfAttribute(string condition) { }
        public DisableIfAttribute(string condition, object value) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class ReadOnlyAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class ButtonAttribute : Attribute
    {
        public ButtonAttribute() { }
        public ButtonAttribute(string name) { }
        public ButtonAttribute(int buttonHeight) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class InfoBoxAttribute : Attribute
    {
        public InfoBoxAttribute(string message) { }
        public InfoBoxAttribute(string message, object messageType) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class InlineEditorAttribute : Attribute
    {
        public InlineEditorAttribute() { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class OdinSerializeAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class PropertyOrderAttribute : Attribute
    {
        public PropertyOrderAttribute() { }
        public PropertyOrderAttribute(int order) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class BoxGroupAttribute : Attribute
    {
        public BoxGroupAttribute() { }
        public BoxGroupAttribute(string group) { }
        public BoxGroupAttribute(string group, bool showLabel) { }
        public BoxGroupAttribute(string group, bool showLabel, bool centerLabel) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class FoldoutGroupAttribute : Attribute
    {
        public FoldoutGroupAttribute(string group) { }
        public FoldoutGroupAttribute(string group, bool expanded) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class HorizontalGroupAttribute : Attribute
    {
        public HorizontalGroupAttribute() { }
        public HorizontalGroupAttribute(string group) { }
        public HorizontalGroupAttribute(string group, float width) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class VerticalGroupAttribute : Attribute
    {
        public VerticalGroupAttribute() { }
        public VerticalGroupAttribute(string group) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class TitleAttribute : Attribute
    {
        public TitleAttribute(string title) { }
        public TitleAttribute(string title, string subtitle) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class LabelTextAttribute : Attribute
    {
        public LabelTextAttribute(string text) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class RequiredAttribute : Attribute
    {
        public RequiredAttribute() { }
        public RequiredAttribute(string message) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = false, Inherited = false)]
    public class ValidateInputAttribute : Attribute
    {
        public ValidateInputAttribute(string condition) { }
        public ValidateInputAttribute(string condition, string message) { }
    }

    [AttributeUsage(AttributeTargets.All, AllowMultiple = true, Inherited = false)]
    public class OnValueChangedAttribute : Attribute
    {
        public OnValueChangedAttribute(string action) { }
    }
}
#endif
