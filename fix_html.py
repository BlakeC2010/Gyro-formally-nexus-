#!/usr/bin/env python3
"""Fix corrupted index.html by extracting CSS and JavaScript properly"""

import re

# Read the corrupted file
with open('static/index.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines: {len(lines)}")

# Find where </style> is
style_close_line = None
for i, line in enumerate(lines):
    if '</style>' in line:
        style_close_line = i
        break

print(f"</style> found at line {style_close_line + 1}")

# Extract CSS part (lines before </style>)
# The CSS section starts at line 13 with <style>
# and should end at the line before </style>

css_lines = lines[12:style_close_line]  # 0-indexed, so line 13 is index 12
print(f"CSS section: lines 13-{style_close_line} ({len(css_lines)} lines)")

# Find where HTML body class starts (after </style>)
# This is where we can salvage the actual HTML structure
html_from_style_close = ''.join(lines[style_close_line:])
body_start = html_from_style_close.find('<body')
if body_start < 0:
    body_start = html_from_style_close.find('</head>')

print(f"Body/structure starts {body_start} chars after </style>")
print(f"\nFirst 200 chars after </style>:")
print(html_from_style_close[:200])
