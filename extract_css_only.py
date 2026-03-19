#!/usr/bin/env python3
"""Aggressively extract ONLY CSS from the corrupted CSS section"""
import re

with open('static/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Split at </style>
before_style_close = content[:content.find('</style>')]
after_style_close = content[content.find('</style>'):]

# Find <style> tag
style_start = before_style_close.find('<style>')
if style_start == -1:
    print("ERROR: No <style> tag found")
    exit(1)

html_head = before_style_close[:style_start + len('<style>')]
mixed_content = before_style_close[style_start + len('<style>'):]

# Extract CSS rules only using regex
# CSS rules:  selectors ending with { ... }
# But we need to be careful with comments

# Remove obvious JavaScript constructs first
lines = mixed_content.split('\n')
pure_css_lines = []

for line in lines:
    stripped = line.strip()
    
    # Skip obviously JS  content
    if (stripped.startswith('async') or 
        stripped.startswith('function') or
        'const ' in stripped and '=' in stripped and ';' in stripped and not 'var(' in stripped or
        stripped.startswith('let ') or
        stripped.startswith('var ') or
        '.push(' in stripped or
        '.value' in stripped or
        '.checked' in stripped or
        '.classList' in stripped or
        'document.' in stripped or
        'getElementById' in stripped or
        'addEventListener' in stripped or
        'fetch(' in stripped or
        'await ' in stripped or
        'JSON.' in stripped or
        'for(' in stripped or
        'if(' in stripped or
        'if ' in stripped or
        '.innerHTML' in stripped or
        '.innerText' in stripped or
        '.textContent' in stripped):
        continue
    
    # Keep CSS
    if (stripped.startswith('.') or
        stripped.startswith(':') or
        stripped.startswith('@') or
        stripped.startswith('body') or
        stripped.startswith('*') or
        stripped.startswith('html') or
        'rgba(' in stripped or
        '{' in stripped or
        '}' in stripped or
        stripped.endswith('{') or
        'border' in stripped or
        'background' in stripped or
        'color' in stripped or
        'font-' in stripped or
        'margin' in stripped or
        'padding' in stripped or
        'display' in stripped or
        'position' in stripped or
        'width' in stripped or
        'height' in stripped or
        'opacity' in stripped or
        'animation' in stripped or
        'transition' in stripped or
        'transform' in stripped or
        '--' in stripped or
        stripped == '' or
        stripped.startswith('/*') or
        stripped.startswith('*') and '*/' in stripped):
        pure_css_lines.append(line)

pure_css = '\n'.join(pure_css_lines)

#Reconstruct
with open('static/index.html', 'w', encoding='utf-8') as f:
    f.write(html_head)
    f.write(pure_css)
    f.write(after_style_close)

print("✓ Extracted pure CSS only")
print(f"  Mixed lines: {len(lines)}")
print(f"  Pure CSS lines: {len(pure_css_lines)}")
print(f"  Removed: {len(lines) - len(pure_css_lines)} JS lines")
