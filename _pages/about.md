---
permalink: /
title: "游戏是逻辑、数学和AI的复合体"
author_profile: true
redirect_from: 
  - /about/
  - /about.html
---

这是一个游戏作为思想的媒介和还原的基础来大一统逻辑、数学、AI的网站。人类历史的开端就附随着游戏精神的发生。游戏与技术和文化，乃至是哲学有着一种紧密的渊源。从火的使用到农业革命，从纸的发展到对纯粹数学的不懈探索，游戏精神都包含了人类对自身自然性超越的努力以及对于自由的渴望。进入21世纪，技术，尤其是那种能改写和影响知识、时间的技术发展起来了。我不得不思索一种更为公正的技术、教育和文化的起点，人是如何与机器打交道的，人又是如何在碎片化、数字化的世界增强人自己的力量。苏格拉底说“认识你自己”的实质就是调教你自己，这是一种伦理实践。开源精神带有某种数字共产主义的色彩，但是其局限的一面也有待挖掘，但是其中有点是积极且明确的，那就是计算能力和AI素养的数字化生存的素质、技能是和以前的自然语言书写、阅读一样的一种基本人权，这需要我们以各种方式来进行捍卫。

学习交流的个人网站
======
这是我用来个人展示、个人学习以及拓展交流可能性的个人网站。在这里我链接了我邮箱、社交媒体以及一些其他可以和我进行联系的平台。“独学则无友、孤陋而寡闻”，我希望有很多有意思的人能跟我进行分享、深入的交流，这样我可以学习到很多。让我们一起探索以游戏为中心和线索的逻辑、数学、CS、AI的种种可能性吧！在这其中我们也会激发对于科学、经济、技术、社会的哲学和社会学以及文化研究的讨论。

Getting started
======
1. Register a GitHub account if you don't have one and confirm your e-mail (required!)
1. Fork [this repository](https://github.com/academicpages/academicpages.github.io) by clicking the "fork" button in the top right. 
1. Go to the repository's settings (rightmost item in the tabs that start with "Code", should be below "Unwatch"). Rename the repository "[your GitHub username].github.io", which will also be your website's URL.
1. Set site-wide configuration and create content & metadata (see below -- also see [this set of diffs](http://archive.is/3TPas) showing what files were changed to set up [an example site](https://getorg-testacct.github.io) for a user with the username "getorg-testacct")
1. Upload any files (like PDFs, .zip files, etc.) to the files/ directory. They will appear at https://[your GitHub username].github.io/files/example.pdf.  
1. Check status by going to the repository settings, in the "GitHub pages" section

Site-wide configuration
------
The main configuration file for the site is in the base directory in [_config.yml](https://github.com/academicpages/academicpages.github.io/blob/master/_config.yml), which defines the content in the sidebars and other site-wide features. You will need to replace the default variables with ones about yourself and your site's github repository. The configuration file for the top menu is in [_data/navigation.yml](https://github.com/academicpages/academicpages.github.io/blob/master/_data/navigation.yml). For example, if you don't have a portfolio or blog posts, you can remove those items from that navigation.yml file to remove them from the header. 

Create content & metadata
------
For site content, there is one markdown file for each type of content, which are stored in directories like _publications, _talks, _posts, _teaching, or _pages. For example, each talk is a markdown file in the [_talks directory](https://github.com/academicpages/academicpages.github.io/tree/master/_talks). At the top of each markdown file is structured data in YAML about the talk, which the theme will parse to do lots of cool stuff. The same structured data about a talk is used to generate the list of talks on the [Talks page](https://academicpages.github.io/talks), each [individual page](https://academicpages.github.io/talks/2012-03-01-talk-1) for specific talks, the talks section for the [CV page](https://academicpages.github.io/cv), and the [map of places you've given a talk](https://academicpages.github.io/talkmap.html) (if you run this [python file](https://github.com/academicpages/academicpages.github.io/blob/master/talkmap.py) or [Jupyter notebook](https://github.com/academicpages/academicpages.github.io/blob/master/talkmap.ipynb), which creates the HTML for the map based on the contents of the _talks directory).

**Markdown generator**

I have also created [a set of Jupyter notebooks](https://github.com/academicpages/academicpages.github.io/tree/master/markdown_generator
) that converts a CSV containing structured data about talks or presentations into individual markdown files that will be properly formatted for the Academic Pages template. The sample CSVs in that directory are the ones I used to create my own personal website at stuartgeiger.com. My usual workflow is that I keep a spreadsheet of my publications and talks, then run the code in these notebooks to generate the markdown files, then commit and push them to the GitHub repository.

How to edit your site's GitHub repository
------
Many people use a git client to create files on their local computer and then push them to GitHub's servers. If you are not familiar with git, you can directly edit these configuration and markdown files directly in the github.com interface. Navigate to a file (like [this one](https://github.com/academicpages/academicpages.github.io/blob/master/_talks/2012-03-01-talk-1.md) and click the pencil icon in the top right of the content preview (to the right of the "Raw | Blame | History" buttons). You can delete a file by clicking the trashcan icon to the right of the pencil icon. You can also create new files or upload files by navigating to a directory and clicking the "Create new file" or "Upload files" buttons. 

Example: editing a markdown file for a talk
![Editing a markdown file for a talk](/images/editing-talk.png)

For more info
------
More info about configuring Academic Pages can be found in [the guide](https://academicpages.github.io/markdown/). The [guides for the Minimal Mistakes theme](https://mmistakes.github.io/minimal-mistakes/docs/configuration/) (which this theme was forked from) might also be helpful.
