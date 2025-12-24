import re
with open('message_1.html', 'r', encoding='utf-8') as f:
    content = f.read()
    match = re.search(r'class="_2ph_ _a6-p"', content)
    if match:
        start = max(0, match.start() - 500)
        end = min(len(content), match.end() + 2000)
        print(content[start:end])
    else:
        print("Not found")
