from pathlib import Path
import re
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT

ROOT = Path(__file__).parent
doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Inches(8.5), Inches(11)
sec.top_margin = sec.bottom_margin = Inches(.68)
sec.left_margin = sec.right_margin = Inches(.75)
sec.footer_distance = Inches(.3)
for name in ['Normal', 'Title', 'Heading 1', 'Heading 2', 'Heading 3']:
    s = doc.styles[name]
    s.font.name = 'Arial'
    s.font.color.rgb = RGBColor(0, 0, 0)
    fonts = s.element.get_or_add_rPr().get_or_add_rFonts()
    for attr in list(fonts.attrib):
        if 'theme' in attr.lower(): del fonts.attrib[attr]
    fonts.set(qn('w:eastAsia'), 'Songti SC')
    for border in s.element.xpath('./w:pPr/w:pBdr'): border.getparent().remove(border)
normal = doc.styles['Normal']
normal.font.size = Pt(11)
normal.paragraph_format.line_spacing = Pt(16.5)
normal.paragraph_format.space_after = Pt(7)
for n, size in [('Title', 22), ('Heading 1', 17), ('Heading 2', 12.5)]:
    s = doc.styles[n]
    s.font.size = Pt(size)
    s.font.bold = True
    s.paragraph_format.space_before = Pt(10 if n != 'Title' else 0)
    s.paragraph_format.space_after = Pt(8)
    s.paragraph_format.line_spacing = Pt(size + 6)

foot = sec.footer.paragraphs[0]
foot.alignment = WD_ALIGN_PARAGRAPH.RIGHT
r = foot.add_run('INOU  |  ')
r.font.size = Pt(8)
field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE')
foot._p.append(field)

def table(lines):
    rows = [[c.strip() for c in l.strip().strip('|').split('|')] for l in lines]
    rows = [rows[0]] + rows[2:]
    t = doc.add_table(rows=0, cols=len(rows[0]))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    widths = [1.45, 1.7, 3.85] if len(rows[0]) == 3 else [1.55, 5.45]
    if rows[0][0] == '编号': widths = [.6, 2.7, 3.7]
    if rows[0][0] == '方案': widths = [2.0, 1.6, 1.4, 2.0]
    for col, w in zip(t.columns, widths): col.width = Inches(w)
    borders = OxmlElement('w:tblBorders')
    for edge in ['top','left','bottom','right','insideH','insideV']:
        b = OxmlElement('w:'+edge); b.set(qn('w:val'),'single'); b.set(qn('w:sz'),'4'); b.set(qn('w:color'),'D9D9D9'); borders.append(b)
    t._tbl.tblPr.append(borders)
    for ri, vals in enumerate(rows):
        row = t.add_row()
        trPr = row._tr.get_or_add_trPr()
        trPr.append(OxmlElement('w:cantSplit'))
        if ri == 0: trPr.append(OxmlElement('w:tblHeader'))
        for j, (c,v) in enumerate(zip(row.cells, vals)):
            c.width = Inches(widths[j]); c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tcPr = c._tc.get_or_add_tcPr()
            sh = OxmlElement('w:shd'); sh.set(qn('w:fill'), 'E8EEF0' if ri == 0 else ('F7F8F8' if ri%2==0 else 'FFFFFF')); tcPr.append(sh)
            mar = OxmlElement('w:tcMar')
            for side in ['top','left','bottom','right']:
                e=OxmlElement('w:'+side); e.set(qn('w:w'),'85'); e.set(qn('w:type'),'dxa'); mar.append(e)
            tcPr.append(mar)
            p=c.paragraphs[0]; p.paragraph_format.space_after=Pt(0); p.paragraph_format.line_spacing=Pt(14)
            r=p.add_run(v); r.font.size=Pt(10); r.bold=ri==0
    p=doc.add_paragraph(); p.paragraph_format.space_after=Pt(0); p.paragraph_format.space_before=Pt(0); p.paragraph_format.line_spacing=Pt(3); p.add_run().font.size=Pt(3)

def hyperlink(p, url):
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    h=OxmlElement('w:hyperlink'); h.set(qn('r:id'),p.part.relate_to(url,RT.HYPERLINK,is_external=True))
    r=OxmlElement('w:r'); pr=OxmlElement('w:rPr'); sz=OxmlElement('w:sz'); sz.set(qn('w:val'),'18'); pr.append(sz); r.append(pr)
    text=OxmlElement('w:t'); text.text=url; r.append(text); h.append(r); p._p.append(h)

lines=(ROOT/'INOU_技术可行性与PRD.md').read_text().splitlines()
i=0
new_page=False
while i<len(lines):
    line=lines[i].strip()
    if not line: i+=1; continue
    if line.startswith('|'):
        block=[]
        while i<len(lines) and lines[i].strip().startswith('|'): block.append(lines[i]); i+=1
        table(block); continue
    if line=='<!-- pagebreak -->': new_page=True
    elif line.startswith('# '): doc.add_paragraph(line[2:], 'Title')
    elif line.startswith('## '):
        p=doc.add_paragraph(line[3:], 'Heading 1')
        if new_page: p.paragraph_format.page_break_before=True; new_page=False
    elif line.startswith('### '): doc.add_paragraph(line[4:], 'Heading 2')
    elif line.startswith('https://'):
        p=doc.add_paragraph(); p.paragraph_format.space_after=Pt(5); hyperlink(p,line)
    elif line.startswith('- '):
        p=doc.add_paragraph('• '+line[2:]); p.paragraph_format.left_indent=Inches(.12); p.paragraph_format.first_line_indent=Inches(-.12)
    else: doc.add_paragraph(line)
    i+=1
doc.core_properties.title='INOU 一对一私域聊天技术可行性与产品需求文档'
doc.core_properties.subject='严格本地存储的 iOS PWA 聊天产品'
doc.core_properties.author=''
refs=False
for p in doc.paragraphs:
    if p.text=='官方参考资料': refs=True; continue
    if refs:
        p.paragraph_format.space_before=Pt(4 if p.style.name=='Heading 2' else 0)
        p.paragraph_format.space_after=Pt(4)
        p.paragraph_format.line_spacing=Pt(14)
        for r in p.runs: r.font.size=Pt(11 if p.style.name=='Heading 2' else 10)
doc.save(ROOT/'INOU_技术可行性与PRD.docx')
print(ROOT/'INOU_技术可行性与PRD.docx')
