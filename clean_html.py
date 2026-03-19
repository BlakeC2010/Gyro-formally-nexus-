#!/usr/bin/env python3
"""Simple reconstruction: Extract good CSS + Extract good HTML body + Join properly"""

with open('static/index.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

#Get the clean parts:
# Part 1: HTML head up to (and closing) the :root CSS dict - approximately lines 1-79
# Part 2: From </style> onwards (line 1257)

# Find the exact line with </style>
style_close_line = next(i for i, line in enumerate(lines) if '</style>' in line)

print(f"Found </style> at line {style_close_line + 1}")

# Lines 0-style_close_line contain <html> through </style>
# This SHOULD work because even if there's JS mixed in the CSS part,
# the </style> TAG properly closes the CSS block.
# Everything from line style_close_line onwards is proper HTML body

part1 = lines[:style_close_line + 1]  # Include </style>
part2 = lines[style_close_line + 1:]   # Everything after </style>

#  Reconstruct  by removing obvious JavaScript from part1
clean_css_lines = []
for line in part1:
    # Keep CSS and HTML structure, remove lines that are clearly JavaScript
    stripped = line.strip()
    
    # Skip lines that are JavaScript function definitions or calls
    if (stripped.startswith('async function') or 
        stripped.startswith('function ') or
        (stripped.startswith('if(') and 'showToast' in stripped) or
        (stripped.startswith('const ') and any(x in stripped for x in ['showToast', 'openResearchModal', 'toggleResearch'])) or
        'const prefix' in stripped or
        'input.value.startsWith' in stripped or
        'researchEnabled' in stripped or
        'openResearchModal' in stripped or
        'toggleResearch' in stripped or
        'startResearchFromModal' in stripped or
        'runDeepResearch' in stripped or
        'await fetch' in stripped or
        'const depth' in stripped or
        'const progress' in stripped or
        'const renderProgress' in stripped or
        'const response' in stripped or
        'const reader' in stripped or
        'progress.push' in stripped or
        'setStatus' in stripped or
        'contentEl.innerHTML' in stripped or
        'openCanvas' in stripped or
        'showToast' in stripped):
        continue  # Skip JS lines
    
    clean_css_lines.append(line)

# Splice back together
reconstructed = ''.join(clean_css_lines) + ''.join(part2)

# Write back
with open('static/index.html', 'w', encoding='utf-8') as f:
    f.write(reconstructed)

print(f"✓ Cleaned up file")
print(f"  Original: {len(lines)} lines")
print(f"  New: {len(reconstructed.split(chr(10)))} lines")
print(f"  (Removed ~{len(lines) - len(reconstructed.split(chr(10)))} JS lines from CSS block)")
