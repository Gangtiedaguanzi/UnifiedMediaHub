using System.Text.RegularExpressions;
using System.Text;
namespace UnifiedMediaHub.Core;

// Same single-segment/code-point rules as worker paths.validCategory. This
// validates the user input; only the worker generates media paths.
public static class CategoryName
{
    public static string Validate(string? text)
    {
        if(string.IsNullOrEmpty(text))return "";
        var clean=Regex.Replace(text,"[\\p{Cc}<>:\"/\\\\|?*]","");
        clean=Regex.Replace(clean,"[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+"," ").Trim(' ').TrimEnd(' ','.');
        clean=string.Concat(clean.EnumerateRunes().Take(40).Select(r=>r.ToString())).TrimEnd(' ','.');
        if(Regex.IsMatch(clean.Split('.')[0],"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant))clean="_"+clean;
        if(clean.Length==0||clean!=text)throw new ArgumentException("分类只允许一个合法目录名，最多40个字符；请去掉路径符号、首尾空格和保留名称。",nameof(text));
        return clean;
    }
}
