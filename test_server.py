#!/usr/bin/env python3
"""Test the HTML being served by the server"""

import urllib.request
import time

time.sleep(2)

try:
    r = urllib.request.urlopen('http://127.0.0.1:5000/', timeout=5)
    html = r.read().decode()
    
    print(f'Status: {r.status}')
    print(f'HTML size: {len(html)} chars')
    print(f'Has DOCTYPE: {"<!DOCTYPE" in html}')
    print(f'Has </html>: {"</html>" in html}')
    print(f'Has <style>: {"<style>" in html}')
    print(f'Has </style>: {"</style>" in html}')
    print(f'Has <body>: {"<body>" in html}')
    print(f'Has <script>: {"<script>" in html}')
    print(f'Has Deep Research function: {"async function runDeepResearch" in html}')
    
    # Check HTML balance
    style_count = html.count('<style>')
    style_close = html.count('</style>')
    print(f'<style> tags: {style_count}, </style> tags: {style_close}')
    
    script_count = html.count('<script')
    script_close = html.count('</script>')
    print(f'<script> tags: {script_count}, </script> tags: {script_close}')
    
    if style_count == style_close and '<!DOCTYPE' in html and '</html>' in html:
        print('\n✓ HTML Structure looks OK!')
    else:
        print('\n⚠ HTML Structure issues detected')
        
except Exception as e:
    print(f'✗ Error: {e}')
