#!/usr/bin/env python3
"""Rebuild index.html by separating CSS and JavaScript properly"""

import re

# Read the corrupted file
with open('static/index.html', 'r', encoding='utf-8') as f:
    full_content = f.read()

#Extract properly structured sections:

# 1. Get the opening HTML and head   
head_match = re.match(r'(<!DOCTYPE.*?<style>)(.*?)(</style>.*?<\/head><body>)(.*)', full_content, re.DOTALL)

if head_match:
    html_start = head_match.group(1)  # DOCTYPE through <style>
    mixed_content = head_match.group(2)  # Everything between <style> and </style>
    style_end_and_body_start = head_match.group(3)  # </style> through </head><body>
    body_and_rest = head_match.group(4)  # Everything after <body>
    
    print("✓ File structure found")
    print(f"  HTML start: {len(html_start)} chars")
    print(f"  Mixed CSS/JS: {len(mixed_content)} chars")
    print(f"  Style end + body start: {len(style_end_and_body_start)} chars")
    print(f"  Body + rest: {len(body_and_rest)} chars")
    
    # Extract CSS rules from mixed content (lines starting with . or : or @ are usually CSS)
    css_rules = []
    js_funcs = []
    
    lines = mixed_content.split('\n')
    for line in lines:
        stripped = line.strip()
        # CSS rules typically start with . : @ or contain { } 
        # JS typically has function names, const, let, etc.
        if (stripped.startswith('.') or stripped.startswith(':') or stripped.startswith('@')
            or ('{' in stripped and ('}' in stripped or '}' not in stripped))
            or 'border' in stripped or 'background' in stripped or 'color' in stripped
            or 'font' in stripped or 'display' in stripped or 'padding' in stripped
            or stripped.endswith('{') or stripped == '}'):
            css_rules.append(line)
        elif (stripped.startswith('function ') or stripped.startswith('async function')
              or stripped.startswith('const ') or stripped.startswith('let ')
              or stripped.startswith('var ') or stripped.startswith('if(')
              or stripped.startswith('if ') or 'function ' in stripped):
            js_funcs.append(line)
        elif stripped and not stripped.startswith('//') and not stripped.startswith('/*') and not stripped.startswith('*/'):
            # Try to guess based on content
            if any(x in stripped for x in ['{', '}', '(', ')', '=', ';']):
                if any(x in stripped for x in [':', 'var(--', 'rgba', 'px', 'vh', '%']):
                    css_rules.append(line)
                else:
                    js_funcs.append(line)
            else:
                css_rules.append(line)
        else:
            css_rules.append(line)  # Keep comments and empty lines with CSS for now
    
    print(f"\nExtracted ~{len(css_rules)} CSS lines and ~{len(js_funcs)} JS lines")
    
    # Join and clean
    css_merged = '\n'.join(css_rules).strip()
    
    # Write the fixed file
    with open('static/index.html', 'w', encoding='utf-8') as f:
        f.write(html_start)
        f.write(css_merged)
        f.write(style_end_and_body_start)
        f.write(body_and_rest)
    
    print("\n✓ Rebuilt index.html")
else:
    print("✗ Could not parse file structure")
